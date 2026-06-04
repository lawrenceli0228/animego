"use client";

// ─────────────────────────────────────────────────────────────────────
// LABELS NEEDED (DetailActions.tsx must pass via labels prop):
//   title              — header label, e.g. "磁力搜索" / "Torrent Search"
//   searchBtn          — primary search button, e.g. "搜索" / "Search"
//   placeholder        — search input placeholder, e.g. "搜索词..."
//   groupAll           — left-column "All groups" row, e.g. "全部" / "All"
//   epAll              — episode-filter "All" pill, e.g. "全集" / "All"
//   loading            — center-column busy state, e.g. "搜索中..."
//   noResults          — center-column empty state, e.g. "暂无搜索结果"
//   close              — aria-label for close button, e.g. "关闭" / "Close"
//   copy               — title attr on copy button, e.g. "复制"
//   copied             — short ✓ confirmation, e.g. "已复制" / "Copied!"
//   openMagnet         — title attr on open button, e.g. "打开"
//   seeders            — short seed-count prefix, e.g. "做种" / "Seeds"
//
// All twelve keys exist in next-app/src/locales/{zh,en}.ts under `torrent`.
// The DetailActions parent maps them through.
// ─────────────────────────────────────────────────────────────────────
//
// v2 port of client/src/components/anime/TorrentModal.jsx, now driven by
// anilistId. Layout: 3-column body (185px fansub list / center scrollable
// rows / 128px cover thumbnail), title-variant pills, episode pills,
// fansub filter, copy / open-magnet actions, ESC + backdrop close, body
// scroll-lock.
//
// Data source (primary): GET /api/anime/torrents?anilistId=<number>
//   go-api resolves the AniList title variants + AnimeTosho aid feed,
//   dedups by infohash, and returns the list ALREADY SORTED by seeders
//   desc (unknown-seeder rows sink to the bottom). The front-end therefore
//   does NOT re-rank the full list — it preserves server order and only
//   buckets by fansub / filters by selected episode.
//
// Data source (manual fallback): GET /api/anime/torrents?q=<keyword>
//   The search box + title-variant pills still issue keyword searches so a
//   user can override the auto query (e.g. an alternate romanisation the
//   variant expansion missed). Both modes return the same envelope.
//
//   Response envelope: { data: TorrentItem[] }  — apiGet unwraps `data`.
//   Per-item shape: { title, magnet, size, fansub, date, source, seeders,
//   infohash, provider? }. `seeders` is omitted/`null` when the source
//   can't report it; `infohash` is the server-side dedup key.
//
// Cache behavior: backend caches results 1h server-side per request key.
// We pass `cache: 'no-store'` so each modal-open / new query hits the
// backend fresh — bandwidth is cheap (server-cached) and torrents
// staleness matters more than CDN economics for this surface.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import FadeImage from "@/components/ui/FadeImage";
import type { Lang } from "@/lib/i18n";

// Module-level cache: keyed by the request key (anilistId-derived for the
// primary path, lowercased keyword for manual searches), 5min TTL — matches
// the legacy TanStack Query `staleTime: 5 * 60 * 1000` in client/src/hooks/
// useAnime.js so re-opening the modal (or switching title-variant pills
// within the same modal) returns instantly instead of round-tripping to
// the backend on every interaction. Backend already caches 1h server-
// side, so even a cold module cache hits a hot backend cache; this layer
// just removes the network round-trip.
const TORRENT_CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { items: TorrentItem[]; ts: number };
const torrentCache = new Map<string, CacheEntry>();

// ─── Types ──────────────────────────────────────────────────────────

interface TorrentItem {
  title: string;
  magnet: string;
  size: string;
  fansub: string | null;
  date: string | null;
  source: "garden" | "nyaa" | "acg" | "dmhy" | string;
  /**
   * Peer seed count, or null/undefined when the source can't report it.
   * go-api emits `seeders` with `omitempty`, so the key is absent (→
   * undefined) for RSS scrapes and any garden row missing the field; a
   * known 0 is a genuine zero-seed torrent. Both undefined and null are
   * treated as "unknown" by the UI.
   */
  seeders: number | null;
  /**
   * Normalised BitTorrent infohash (server-side dedup key). Absent when the
   * magnet carries no parseable hash, hence optional.
   */
  infohash?: string;
  provider?: string | null;
}

interface AnimeSummary {
  anilistId: number;
  episodes?: number | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleChinese: string | null;
  titleNative: string | null;
  coverImageUrl: string | null;
}

interface TorrentLabels {
  title: string;
  searchBtn: string;
  placeholder: string;
  groupAll: string;
  epAll: string;
  loading: string;
  noResults: string;
  close: string;
  copy: string;
  copied: string;
  openMagnet: string;
  /** Short label prefixed to the seed count, e.g. "Seeds" / "做种". */
  seeders: string;
}

interface TorrentModalProps {
  anime: AnimeSummary;
  labels: TorrentLabels;
  onClose: () => void;
  /** Language used to localise internal source labels (e.g. "花园" → "Garden"). Defaults to "en". */
  lang?: Lang;
}

interface TitleOption {
  label: string;
  value: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseTags(title: string): {
  resolution: string | null;
  tags: string[];
} {
  const res =
    title.match(/\b(4K|2160[Pp]|1080[Pp]|720[Pp]|480[Pp])\b/)?.[1]?.toUpperCase() ?? null;
  const codec = title.match(/\b(HEVC|AVC|x265|x264|H\.?265|H\.?264)\b/i)?.[1] ?? null;
  const source = title.match(/\b(WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay)\b/i)?.[1] ?? null;
  return { resolution: res, tags: [codec, source].filter((t): t is string => Boolean(t)) };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// Score 1 if title contains this specific episode number (common patterns).
// Mirrors legacy epRelevance in client/src/components/anime/TorrentModal.jsx
// so sort / filter behavior matches across the two surfaces.
function epRelevance(title: string, epPad: string): number {
  const epNum = String(parseInt(epPad, 10));
  const patterns = [
    `- ${epPad}`,
    `- ${epNum} `,
    `- ${epNum}]`,
    `- ${epNum}.`,
    `[${epPad}]`,
    `[${epNum}]`,
    ` ${epPad} `,
    ` ${epPad}.`,
  ];
  return patterns.some((p) => title.includes(p)) ? 1 : 0;
}

// ─── GroupRow sub-component ─────────────────────────────────────────

interface GroupRowProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function GroupRow({ label, count, active, onClick }: GroupRowProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "7px 8px",
        borderRadius: 8,
        background: active
          ? "rgba(10,132,255,0.25)"
          : hovered
            ? "rgba(255,255,255,0.04)"
            : "transparent",
        border: active
          ? "1px solid rgba(10,132,255,0.45)"
          : "1px solid transparent",
        color: active ? "#0a84ff" : "rgba(235,235,245,0.60)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        textAlign: "left",
        transition: "all 0.15s",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 118,
        }}
      >
        {label}
      </span>
      <span
        style={{
          flexShrink: 0,
          marginLeft: 6,
          fontSize: 10,
          fontWeight: 700,
          padding: "1px 6px",
          borderRadius: 10,
          background: active
            ? "rgba(10,132,255,0.4)"
            : "rgba(120,120,128,0.12)",
          color: active ? "#0a84ff" : "rgba(235,235,245,0.30)",
        }}
      >
        {count}
      </span>
    </button>
  );
}

// ─── TorrentRow sub-component ───────────────────────────────────────

interface TorrentRowProps {
  item: TorrentItem;
  copied: boolean;
  onCopy: () => void;
  onOpen: () => void;
  copyLabel: string;
  copiedLabel: string;
  openLabel: string;
  seedersLabel: string;
  lang: Lang;
}

function sourceBg(source: string): string {
  if (source === "nyaa") return "rgba(90,200,250,0.1)";
  if (source === "garden" || source === "dmhy") return "rgba(52,211,153,0.1)";
  return "rgba(84,84,88,0.30)";
}

function sourceColor(source: string): string {
  if (source === "nyaa") return "#5ac8fa";
  if (source === "garden" || source === "dmhy") return "#34d399";
  return "rgba(235,235,245,0.30)";
}

function sourceLabel(source: string, lang: Lang = "en"): string {
  if (source === "garden" || source === "dmhy") return lang === "zh" ? "花园" : "Garden";
  return source;
}

function sourceTooltip(item: TorrentItem): string | undefined {
  if (item.source === "garden" && item.provider) {
    return `animes.garden · via ${item.provider}`;
  }
  if (item.source === "garden") return "animes.garden";
  return undefined;
}

// Health-coded seed colour: green for well-seeded, amber for thin, muted
// for dead/zero. `seeders` is normalised to a number here (null/undefined
// callers are handled by the row before this runs).
function seederColor(seeders: number): string {
  if (seeders >= 20) return "#34d399";
  if (seeders > 0) return "#f5a623";
  return "rgba(235,235,245,0.30)";
}

function TorrentRow({
  item,
  copied,
  onCopy,
  onOpen,
  copyLabel,
  copiedLabel,
  openLabel,
  seedersLabel,
  lang,
}: TorrentRowProps) {
  const { resolution, tags } = parseTags(item.title);
  const [hovered, setHovered] = useState(false);
  // null/undefined → unknown count; a known number (incl. 0) renders.
  const seeders =
    typeof item.seeders === "number" ? item.seeders : null;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: hovered
          ? "rgba(255,255,255,0.04)"
          : "rgba(255,255,255,0.02)",
        border: `1px solid ${hovered ? "rgba(10,132,255,0.3)" : "rgba(84,84,88,0.30)"}`,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        transition: "all 0.15s",
      }}
    >
      {/* Main info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          title={item.title}
          style={{
            fontSize: 12,
            color: "#ffffff",
            lineHeight: 1.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginBottom: 5,
          }}
        >
          {item.title}
        </p>

        {/* Meta row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 5,
          }}
        >
          {/* Seed count — list is server-ranked by seeders desc, so this
              leads the meta row. Unknown (null) renders a muted dash. */}
          <span
            title={seedersLabel}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: 10,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              padding: "1px 6px",
              borderRadius: 4,
              background: "rgba(52,211,153,0.1)",
              color: seeders === null ? "rgba(235,235,245,0.30)" : seederColor(seeders),
            }}
          >
            <span aria-hidden="true">🌱</span>
            {seeders === null ? "—" : seeders}
          </span>
          {resolution && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                fontWeight: 700,
                background: "rgba(90,200,250,0.15)",
                color: "#5ac8fa",
              }}
            >
              {resolution}
            </span>
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                fontWeight: 500,
                background: "rgba(120,120,128,0.12)",
                color: "rgba(235,235,245,0.60)",
              }}
            >
              {tag}
            </span>
          ))}
          {item.size && (
            <span
              style={{
                fontSize: 10,
                color: "rgba(235,235,245,0.30)",
              }}
            >
              {item.size}
            </span>
          )}
          {item.date && (
            <span
              style={{
                fontSize: 10,
                color: "rgba(235,235,245,0.30)",
              }}
            >
              {fmtDate(item.date)}
            </span>
          )}
          {item.source && (
            <span
              title={sourceTooltip(item)}
              style={{
                fontSize: 9,
                padding: "1px 5px",
                borderRadius: 3,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                background: sourceBg(item.source),
                color: sourceColor(item.source),
                cursor: item.source === "garden" ? "help" : "default",
              }}
            >
              {sourceLabel(item.source, lang)}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div
        style={{
          display: "flex",
          gap: 5,
          flexShrink: 0,
          alignItems: "center",
          paddingTop: 1,
        }}
      >
        <button
          type="button"
          onClick={onCopy}
          title={copied ? copiedLabel : copyLabel}
          aria-label={copied ? copiedLabel : copyLabel}
          style={{
            padding: "5px 10px",
            borderRadius: 7,
            border: "none",
            cursor: "pointer",
            background: copied
              ? "rgba(16,185,129,0.2)"
              : "rgba(10,132,255,0.2)",
            color: copied ? "#34d399" : "#0a84ff",
            fontSize: 12,
            fontWeight: 700,
            transition: "all 0.2s",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? "✓" : "⎘"}
        </button>
        <button
          type="button"
          onClick={onOpen}
          title={openLabel}
          aria-label={openLabel}
          style={{
            padding: "5px 10px",
            borderRadius: 7,
            border: "none",
            cursor: "pointer",
            background: "rgba(90,200,250,0.15)",
            color: "#5ac8fa",
            fontSize: 12,
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          ↗
        </button>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────

export default function TorrentModal({
  anime,
  labels,
  onClose,
  lang = "en",
}: TorrentModalProps) {
  const defaultQ = anime.titleRomaji || anime.titleEnglish || "";

  // `query` is the search-box text. `manualQ` is the active manual override:
  //   - null  → primary path, fetch by anilistId (server expands variants)
  //   - "..." → fetch that keyword via ?q= (search box / title pill)
  const [query, setQuery] = useState(defaultQ);
  const [manualQ, setManualQ] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("ALL");
  const [selectedEp, setSelectedEp] = useState<number | null>(null);

  const [torrents, setTorrents] = useState<TorrentItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // ─── Data fetch ─────────────────────────────────────────────────
  // No react-query in next-app; manage state by hand. Cancel any in-flight
  // request when the query changes mid-load so a fast double-search doesn't
  // race a slow first request to overwrite fresh results.
  //
  // Primary path queries by anilistId — go-api resolves the title variants,
  // pulls the AnimeTosho aid feed, dedups, and returns the list already
  // sorted by seeders desc. A manual override (search box / title pill)
  // switches to keyword ?q=. Either way the response is TorrentItem[].
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const term = manualQ?.trim() ?? "";
    const isManual = manualQ !== null;

    // Manual search with an empty box → nothing to query.
    if (isManual && !term) {
      setTorrents([]);
      setIsLoading(false);
      return;
    }

    const path = isManual
      ? `/api/anime/torrents?q=${encodeURIComponent(term)}`
      : `/api/anime/torrents?anilistId=${anime.anilistId}`;
    // Cache key namespaces the two modes so an anilistId result and a
    // keyword result never collide.
    const cacheKey = isManual
      ? `q:${term.toLowerCase()}`
      : `id:${anime.anilistId}`;

    // Stale-while-revalidate: paint a fresh cached entry immediately and
    // skip the network round-trip. Falls through to fetch on miss / expiry.
    const cached = torrentCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TORRENT_CACHE_TTL_MS) {
      setTorrents(cached.items);
      setIsLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    apiGet<TorrentItem[]>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const items = Array.isArray(data) ? data : [];
        torrentCache.set(cacheKey, { items, ts: Date.now() });
        setTorrents(items);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Abort errors swallow silently; surface anything else as an empty
        // list (the noResults copy covers the user-facing case, and the
        // detail page logs ApiError through its own boundary).
        void (err instanceof ApiError);
        setTorrents([]);
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [manualQ, anime.anilistId]);

  // ─── Escape + body scroll lock ──────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  // ─── Copy magnet with 2s ✓ animation ────────────────────────────
  const copyMagnet = useCallback((magnet: string, idx: number) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(magnet).catch(() => {});
    }
    setCopiedIdx(idx);
    window.setTimeout(() => {
      setCopiedIdx((c) => (c === idx ? null : c));
    }, 2000);
  }, []);

  // ─── Title variant pills (dedup by value) ──────────────────────
  const titleOptions: TitleOption[] = useMemo(() => {
    const raw: (TitleOption | null)[] = [
      anime.titleChinese ? { label: lang === "zh" ? "中文" : "Chinese", value: anime.titleChinese } : null,
      anime.titleRomaji ? { label: "Romaji", value: anime.titleRomaji } : null,
      anime.titleEnglish && anime.titleEnglish !== anime.titleRomaji
        ? { label: "English", value: anime.titleEnglish }
        : null,
      anime.titleNative ? { label: "日本語", value: anime.titleNative } : null,
    ];
    const opts = raw.filter((opt): opt is TitleOption => opt !== null);
    return opts.filter(
      (opt, i) => opts.findIndex((o) => o.value === opt.value) === i,
    );
  }, [
    anime.titleChinese,
    anime.titleRomaji,
    anime.titleEnglish,
    anime.titleNative,
  ]);

  // Manual keyword search (search box Enter / button, or a title pill).
  // Switches the fetch off the anilistId path and onto ?q=<keyword>.
  const triggerSearch = useCallback((newQ: string) => {
    setManualQ(newQ);
    setSelectedGroup("ALL");
  }, []);

  const applyTitle = useCallback(
    (title: string) => {
      setQuery(title);
      triggerSearch(title);
    },
    [triggerSearch],
  );

  // ─── Group + filter + sort ──────────────────────────────────────
  const { groups, groupNames, filteredTorrents } = useMemo(() => {
    const epPad = selectedEp ? String(selectedEp).padStart(2, "0") : null;

    const grouped: Record<string, TorrentItem[]> = {};
    for (const item of torrents ?? []) {
      const g = item.fansub ?? "Unknown";
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(item);
    }
    const sortedNames = Object.keys(grouped).sort(
      (a, b) => grouped[b].length - grouped[a].length,
    );

    const base: TorrentItem[] = !torrents
      ? []
      : selectedGroup === "ALL"
        ? torrents
        : (grouped[selectedGroup] ?? []);

    // The server already returns the list ranked by seeders desc, so we do
    // NOT re-rank. The only client-side reshaping is the optional episode
    // filter: when a specific ep is selected, surface its rows first.
    //
    // Episode partition with fallback: keep rows whose title matches the
    // selected episode ahead of the rest while preserving the server's
    // seeder order within each partition (stable). If nothing matches the
    // episode number (fansubs with unconventional numbering), fall back to
    // the unfiltered, server-ranked list rather than showing an empty state.
    let filteredTorrents = base;
    if (epPad) {
      const matched = base.filter((item) => epRelevance(item.title, epPad) > 0);
      if (matched.length > 0) {
        const rest = base.filter((item) => epRelevance(item.title, epPad) === 0);
        filteredTorrents = [...matched, ...rest];
      }
    }

    return {
      groups: grouped,
      groupNames: sortedNames,
      filteredTorrents,
    };
  }, [torrents, selectedGroup, selectedEp]);

  const episodes = anime.episodes ?? 0;
  const heroTitle = anime.titleRomaji || anime.titleEnglish || "";

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.80)",
        backdropFilter: "blur(8px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#000000",
          border: "1px solid rgba(120,120,128,0.12)",
          borderRadius: 16,
          width: "100%",
          maxWidth: 1320,
          height: "min(90vh, 820px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ── HEADER ── */}
        <div
          style={{
            padding: "14px 18px 12px",
            borderBottom: "1px solid rgba(84,84,88,0.30)",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                color: "#0a84ff",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "2px",
                textTransform: "uppercase",
              }}
            >
              {labels.title}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={labels.close}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#ffffff";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "rgba(235,235,245,0.30)";
              }}
              style={{
                background: "none",
                border: "none",
                color: "rgba(235,235,245,0.30)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: 4,
              }}
            >
              ✕
            </button>
          </div>

          {/* Title variant pills */}
          {titleOptions.length > 1 && (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              {titleOptions.map((opt) => (
                <button
                  type="button"
                  key={opt.label}
                  onClick={() => applyTitle(opt.value)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "rgba(10,132,255,0.6)";
                    e.currentTarget.style.color = "#0a84ff";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "rgba(84,84,88,0.65)";
                    e.currentTarget.style.color = "rgba(235,235,245,0.50)";
                  }}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 20,
                    border: "1px solid rgba(84,84,88,0.65)",
                    background: "transparent",
                    color: "rgba(235,235,245,0.50)",
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                    transition: "all 0.15s",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      color: "rgba(235,235,245,0.35)",
                      marginRight: 4,
                    }}
                  >
                    {opt.label}
                  </span>
                  {opt.value.length > 18 ? opt.value.slice(0, 18) + "…" : opt.value}
                </button>
              ))}
            </div>
          )}

          {/* Episode selector pills */}
          {episodes > 0 && (
            <div
              style={{
                display: "flex",
                gap: 5,
                overflowX: "auto",
                scrollbarWidth: "none",
                paddingBottom: 1,
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedEp(null)}
                style={{
                  padding: "3px 10px",
                  borderRadius: 20,
                  border: "none",
                  cursor: "pointer",
                  background:
                    selectedEp === null ? "#0a84ff" : "rgba(255,255,255,0.06)",
                  color: selectedEp === null ? "#fff" : "rgba(235,235,245,0.50)",
                  fontSize: 11,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  transition: "all 0.15s",
                }}
              >
                {labels.epAll}
              </button>
              {Array.from({ length: episodes }, (_, i) => i + 1).map((ep) => (
                <button
                  type="button"
                  key={ep}
                  onClick={() => setSelectedEp(ep)}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 20,
                    border: "none",
                    cursor: "pointer",
                    background:
                      selectedEp === ep ? "#0a84ff" : "rgba(255,255,255,0.06)",
                    color:
                      selectedEp === ep ? "#fff" : "rgba(235,235,245,0.50)",
                    fontSize: 11,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    transition: "all 0.15s",
                  }}
                >
                  {String(ep).padStart(2, "0")}
                </button>
              ))}
            </div>
          )}

          {/* Search bar */}
          <div style={{ display: "flex", gap: 10 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") triggerSearch(query);
              }}
              placeholder={labels.placeholder}
              style={{
                flex: 1,
                padding: "8px 13px",
                borderRadius: 9,
                border: "1px solid #38383a",
                background: "rgba(255,255,255,0.04)",
                color: "#ffffff",
                fontSize: 13,
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={() => triggerSearch(query)}
              style={{
                padding: "8px 18px",
                borderRadius: 9,
                flexShrink: 0,
                background: "#0a84ff",
                color: "#fff",
                fontWeight: 700,
                fontSize: 13,
                border: "none",
                cursor: "pointer",
              }}
            >
              {labels.searchBtn}
            </button>
          </div>
        </div>

        {/* ── BODY (three columns) ── */}
        <div
          style={{
            display: "flex",
            flex: 1,
            overflow: "hidden",
          }}
        >
          {/* LEFT — fansub group list */}
          <div
            style={{
              width: 185,
              flexShrink: 0,
              borderRight: "1px solid rgba(84,84,88,0.30)",
              overflowY: "auto",
              padding: "10px 8px",
              background: "#1c1c1e",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {heroTitle && (
              <p
                style={{
                  fontSize: 10,
                  color: "rgba(235,235,245,0.30)",
                  fontWeight: 600,
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  padding: "2px 6px 8px",
                }}
              >
                {heroTitle}
              </p>
            )}
            <GroupRow
              label={labels.groupAll}
              count={torrents?.length ?? 0}
              active={selectedGroup === "ALL"}
              onClick={() => setSelectedGroup("ALL")}
            />
            {groupNames.map((g) => (
              <GroupRow
                key={g}
                label={g}
                count={groups[g].length}
                active={selectedGroup === g}
                onClick={() => setSelectedGroup(g)}
              />
            ))}
          </div>

          {/* CENTER — torrent list */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "10px 12px",
            }}
          >
            {isLoading ? (
              <p
                style={{
                  color: "rgba(235,235,245,0.30)",
                  textAlign: "center",
                  padding: "60px 0",
                }}
              >
                {labels.loading}
              </p>
            ) : !filteredTorrents.length ? (
              <p
                style={{
                  color: "rgba(235,235,245,0.30)",
                  textAlign: "center",
                  padding: "60px 0",
                }}
              >
                {labels.noResults}
              </p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                {filteredTorrents.map((item, i) => (
                  <TorrentRow
                    key={`${item.infohash || item.magnet.slice(0, 64)}-${i}`}
                    item={item}
                    copied={copiedIdx === i}
                    onCopy={() => copyMagnet(item.magnet, i)}
                    onOpen={() => window.open(item.magnet)}
                    copyLabel={labels.copy}
                    copiedLabel={labels.copied}
                    openLabel={labels.openMagnet}
                    seedersLabel={labels.seeders}
                    lang={lang}
                  />
                ))}
              </div>
            )}
          </div>

          {/* RIGHT — cover image */}
          <div
            style={{
              width: 128,
              flexShrink: 0,
              borderLeft: "1px solid rgba(84,84,88,0.30)",
              background: "#1c1c1e",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
              padding: "14px 10px",
            }}
          >
            {anime.coverImageUrl && (
              // 106×152 modal thumbnail. FadeImage gives it the same
              // load-fade as every other cover on the site (AniList CDN
              // arbitrary host, so plain <img> not next/image).
              <FadeImage
                src={anime.coverImageUrl}
                alt={anime.titleRomaji ?? heroTitle ?? ""}
                style={{
                  width: 106,
                  height: 152,
                  objectFit: "cover",
                  borderRadius: 10,
                  border: "2px solid rgba(10,132,255,0.35)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
