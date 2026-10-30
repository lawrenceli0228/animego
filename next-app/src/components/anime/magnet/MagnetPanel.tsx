"use client";

// The magnet panel on /anime/[id] — design A: a drawer from the right on
// desktop, a sheet from the bottom on a phone.
//
// One request lists every release the sources hold for this anime (go-api
// searches all its titles at once, the default), or for one keyword (a title
// button or the search box). The answer comes whole — a cold search takes
// several seconds — so the panel shows the sources being asked and skeleton
// rows until it lands, then swaps the list in at once.
//
// Cut by a release-group strip and a subtitle-script filter, in the server's
// order (seeders, date, source). Nothing is ranked, pinned or labelled as a
// recommendation: this is an index of what exists.
//
// Portaled to <body>: the detail hero is `isolation: isolate`, which caps any
// z-index inside it, and the page behind must not scroll (lib/scrollLock —
// locking <body> does nothing here, see #200).

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import FadeImage from "@/components/ui/FadeImage";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import {
  episodeLabel,
  fansubCells,
  SUB_FILTERS,
  visibleRows,
  type MagnetRow,
  type SubFilter,
} from "@/lib/magnet/list";
import { magnetToneVars, titleVariants, type TitleVariantKind } from "@/lib/magnet/titles";
import { useScrollLock } from "@/lib/scrollLock";
import { copyText } from "./copyText";
import FansubStrip from "./FansubStrip";
import { CloseIcon, SearchIcon } from "./icons";
import ReleaseRow, { type ReleaseRowText } from "./ReleaseRow";
import { BATCH_SIZE, useBatchedRows } from "./useBatchedRows";
import { useDialogFocus } from "./useDialogFocus";
import { useEpisodeOffset, useTorrentRows } from "./useMagnetData";
import s from "./MagnetPanel.module.css";

export interface MagnetAnime {
  anilistId: number;
  /** This season's episode count (AniList's), or null while unknown. */
  episodes: number | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleChinese: string | null;
  titleNative: string | null;
  coverImageUrl: string | null;
}

export interface MagnetPanelProps {
  anime: MagnetAnime;
  /** The anime's title as the page shows it. */
  heading: string;
  /** The hue the page is painted in, or null for none. */
  hue: number | null;
  onClose: () => void;
  /** Where focus goes on close when what opened the panel cannot take it back. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** How long a copy confirmation stays, ms. */
const COPIED_MS = 2000;
/** Entrance stagger per row within a batch, ms, capped after this many rows. */
const STAGGER_MS = 22;
const STAGGER_ROWS = 12;
/** Skeleton rows while searching. */
const SKELETON_ROWS = 6;
/** The sources the search pills name, in the order the canvas shows them. */
const SEARCHED_SOURCES = ["dmhy", "garden", "nyaa", "mikan"] as const;

export default function MagnetPanel({ anime, heading, hue, onClose, returnFocusRef }: MagnetPanelProps) {
  const { t } = useLang();
  const titleId = useId();
  const kickerId = useId();

  const [query, setQuery] = useState("");
  const [manualQ, setManualQ] = useState<string | null>(null);
  const [variant, setVariant] = useState<TitleVariantKind | null>(null);
  const [subFilter, setSubFilter] = useState<SubFilter>("all");
  const [fansub, setFansub] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);

  useScrollLock(true);
  useDialogFocus(panelRef, onClose, returnFocusRef);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const list = useTorrentRows(anime.anilistId, manualQ);
  const offset = useEpisodeOffset(anime.anilistId);
  const loading = list.status === "loading";

  const cells = useMemo(() => fansubCells(list.rows, subFilter, fansub), [list.rows, subFilter, fansub]);
  const shown = useMemo(() => visibleRows(list.rows, subFilter, fansub), [list.rows, subFilter, fansub]);
  const limit = useBatchedRows(
    shown.length,
    `${list.status}|${manualQ ?? ""}|${subFilter}|${fansub ?? "\u0000"}|${list.rows.length}`,
    bodyRef,
    endRef,
  );

  const variants = useMemo(() => titleVariants(anime), [anime]);
  const variantLabel: Record<TitleVariantKind, string> = {
    chinese: t("torrent.variantChinese"),
    romaji: "Romaji",
    english: "English",
    native: "日本語",
  };
  const subLabel: Record<SubFilter, string> = {
    all: t("torrent.subAll"),
    simp: t("torrent.subSimp"),
    trad: t("torrent.subTrad"),
    both: t("torrent.subBoth"),
  };
  const sourceNames: Record<string, string> = {
    dmhy: t("torrent.srcDmhy"),
    garden: t("torrent.srcGarden"),
    nyaa: t("torrent.srcNyaa"),
    mikan: t("torrent.srcMikan"),
    tosho: t("torrent.srcTosho"),
    acg: t("torrent.srcAcg"),
  };
  const scriptTag = { simp: t("torrent.tagSimp"), trad: t("torrent.tagTrad"), both: t("torrent.tagBoth") };
  const embedTag = { hard: t("torrent.embedHard"), soft: t("torrent.embedSoft") };
  const episodeTemplate = t("torrent.episode");
  const batchWord = t("torrent.batch");
  const subTagTemplate = t("torrent.subTag");
  const rowText: ReleaseRowText = useMemo(
    () => ({
      unnamed: t("torrent.unnamed"),
      copy: t("torrent.copyMagnet"),
      copied: t("torrent.copied"),
      open: t("torrent.openInClient"),
    }),
    [t],
  );

  const scrollListToTop = () => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  const search = (term: string | null, kind: TitleVariantKind | null) => {
    setVariant(kind);
    setManualQ(term);
    setFansub(null);
    scrollListToTop();
  };

  const pickVariant = (kind: TitleVariantKind, value: string) => {
    if (variant === kind) return;
    setQuery(value);
    search(value, kind);
  };

  const submit = () => {
    const term = query.trim();
    // An empty box goes back to searching every title by id.
    search(term ? term : null, null);
  };

  const pickSub = (next: SubFilter) => {
    setSubFilter(next);
    scrollListToTop();
  };

  const pickFansub = (next: string | null) => {
    setFansub(next);
    scrollListToTop();
  };

  const clearFilters = () => {
    setSubFilter("all");
    setFansub(null);
    scrollListToTop();
  };

  const onCopy = useCallback(async (row: MagnetRow) => {
    if (!(await copyText(row.magnet))) return;
    setCopiedKey(row.key);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedKey(null), COPIED_MS);
  }, []);

  const onOpen = useCallback((row: MagnetRow) => {
    window.open(row.magnet);
  }, []);

  const episodeText = (row: MagnetRow): string | null => {
    const label = episodeLabel(row.facts.episode, anime.episodes, offset);
    if (label === null) return null;
    return label.kind === "batch" ? batchWord : fillTemplate(episodeTemplate, { n: label.n });
  };

  const subTagFor = (row: MagnetRow) => {
    const { script, embed } = row.facts;
    if (!script) return null;
    return embed
      ? fillTemplate(subTagTemplate, { script: scriptTag[script], embed: embedTag[embed] })
      : scriptTag[script];
  };

  const toneStyle = magnetToneVars(hue) as CSSProperties;
  const placeholder = anime.titleChinese || anime.titleRomaji || t("torrent.placeholder");
  const filtered = subFilter !== "all" || fansub !== null;

  let body;
  if (loading) {
    body = (
      <>
        <div className={s.srcs} aria-hidden="true">
          {SEARCHED_SOURCES.map((src) => (
            <span key={src} className={s.src}>
              <i className={s.spinner} />
              {sourceNames[src]}
            </span>
          ))}
        </div>
        <div className={s.list} aria-hidden="true">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className={s.sk} />
          ))}
        </div>
      </>
    );
  } else if (list.status === "error") {
    body = (
      <div className={s.empty}>
        {t("torrent.searchFailed")}
        <button type="button" className={s.chip} onClick={list.retry}>
          {t("torrent.retry")}
        </button>
      </div>
    );
  } else if (shown.length === 0) {
    body = (
      <div className={s.empty}>
        {t("torrent.notFound")}
        <button type="button" className={s.chip} onClick={filtered ? clearFilters : list.retry}>
          {filtered ? t("torrent.clearFilters") : t("torrent.retry")}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <div className={s.list}>
          {shown.slice(0, limit).map((row, i) => (
            <ReleaseRow
              key={row.key}
              row={row}
              index={i}
              stagger={Math.min(i % BATCH_SIZE, STAGGER_ROWS) * STAGGER_MS}
              episodeText={episodeText(row)}
              episodeIsWord={row.facts.episode?.kind === "batch"}
              subTag={subTagFor(row)}
              sourceName={sourceNames[row.source] ?? row.source}
              copied={copiedKey === row.key}
              text={rowText}
              onCopy={onCopy}
              onOpen={onOpen}
            />
          ))}
        </div>
        <div ref={endRef} aria-hidden="true" />
      </>
    );
  }

  return createPortal(
    <div className={s.root} style={toneStyle}>
      <div className={s.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${kickerId} ${titleId}`}
        tabIndex={-1}
      >
        <div className={s.grab} aria-hidden="true" />
        <div className={s.top}>
          <div className={s.head}>
            <span className={s.cover}>
              {anime.coverImageUrl ? (
                <FadeImage src={anime.coverImageUrl} alt="" width={44} height={62} />
              ) : null}
            </span>
            <div className={s.htext}>
              <span id={kickerId} className={s.srOnly}>
                {t("torrent.title")}
              </span>
              <h2 id={titleId} className={s.h1}>
                {heading}
              </h2>
              <div className={s.count}>
                {t("torrent.download")}
                {list.status === "ready" ? (
                  <>
                    {" "}
                    <b>{shown.length}</b> / {list.rows.length} {t("torrent.countUnit")}
                  </>
                ) : null}
              </div>
            </div>
            <button type="button" className={s.close} aria-label={t("torrent.close")} onClick={onClose}>
              <CloseIcon />
            </button>
          </div>

          <form
            className={s.search}
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <SearchIcon />
            <input
              type="search"
              value={query}
              placeholder={placeholder}
              aria-label={t("torrent.searchAria")}
              enterKeyHint="search"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className={s.go}>
              {t("torrent.searchBtn")}
            </button>
          </form>

          {variants.length > 1 ? (
            <div className={s.hscroll}>
              <div className={s.vars} role="group" aria-label={t("torrent.variantsAria")}>
                {variants.map((v) => (
                  <button
                    key={v.kind}
                    type="button"
                    className={s.var}
                    aria-pressed={variant === v.kind}
                    title={v.value}
                    onClick={() => pickVariant(v.kind, v.value)}
                  >
                    {variantLabel[v.kind]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <FansubStrip cells={cells} selected={fansub} pending={loading} onPick={pickFansub} />

          <div className={s.filters} role="group" aria-label={t("torrent.subFilterAria")}>
            {SUB_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={s.chip}
                aria-pressed={subFilter === f}
                onClick={() => pickSub(f)}
              >
                {subLabel[f]}
              </button>
            ))}
          </div>
        </div>

        <div ref={bodyRef} className={s.body}>
          <p className={s.srOnly} role="status">
            {loading ? t("torrent.loading") : ""}
          </p>
          {body}
        </div>
      </div>
    </div>,
    document.body,
  );
}
