"use client";

// Client port of legacy EpisodeList.jsx's grid (without the per-cell
// expand/danmaku panel — that's still deferred to P11).
//
// Why a client component on a public detail page: we need per-cell
// watched / current / completed highlighting that reacts to the user's
// +/- clicks in SubscriptionButton. Server rendering the neutral grid
// is fine for SEO (each cell is still in the static HTML with the ep
// number + title), client hydration just adds the colored borders.
//
// Sub state sync: SubscriptionButton emits CustomEvents on the
// subscriptionBus after every successful mutation. We listen + repaint.
// First load: probe /api/subscriptions/:anilistId once via authFetch
// with skipRedirectOnFailure to avoid pushing anonymous users to /login.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "@/lib/authFetch";
import {
  subscribeToBus,
  type SubscriptionDoc,
  type SubStatus,
} from "@/lib/subscriptionBus";
import type { DetailEpisodeTitle } from "@/lib/types";
import type { Dict, Lang } from "@/lib/i18n";
import EpisodeComments from "@/components/anime/EpisodeComments";

interface EpisodesGridProps {
  anilistId: number;
  episodes: number | null;
  episodeTitles: DetailEpisodeTitle[];
  lang: Lang;
  dict: Dict;
}

const VALID_STATUSES: ReadonlyArray<SubStatus> = [
  "watching",
  "completed",
  "plan_to_watch",
  "dropped",
];

function parseSub(raw: unknown): SubscriptionDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const data = (r.data ?? r) as Record<string, unknown>;
  const status = typeof data.status === "string" ? data.status : "watching";
  if (!VALID_STATUSES.includes(status as SubStatus)) return null;
  return {
    status: status as SubStatus,
    currentEpisode:
      typeof data.currentEpisode === "number" ? data.currentEpisode : 0,
    score:
      typeof data.score === "number"
        ? data.score
        : data.score === null
          ? null
          : null,
  };
}

const sectionLabelStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase",
  marginBottom: 16,
};

export default function EpisodesGrid({
  anilistId,
  episodes,
  episodeTitles,
  lang,
  dict,
}: EpisodesGridProps) {
  const [sub, setSub] = useState<SubscriptionDoc | null>(null);
  // Which episode's expand panel is open. null = all collapsed. Matches
  // legacy EpisodeList click-to-expand: click a cell to open its comment
  // panel below, click again to collapse.
  const [openEp, setOpenEp] = useState<number | null>(null);

  // Mount-time probe — silent on 401 / 404 so anonymous users see the
  // neutral grid without an auth bounce. Cancel on unmount in case the
  // user navigates fast.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/subscriptions/${anilistId}`, {
          skipRedirectOnFailure: true,
        });
        if (cancelled || !res.ok) return;
        const json = await res.json();
        const parsed = parseSub(json);
        if (parsed) setSub(parsed);
      } catch {
        /* leave sub as null — grid stays neutral */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anilistId]);

  // Listen for SubscriptionButton mutations. We only care about events
  // for THIS anime; the bus is global.
  useEffect(() => {
    return subscribeToBus((detail) => {
      if (detail.anilistId !== anilistId) return;
      setSub(detail.sub);
    });
  }, [anilistId]);

  const titleByEpisode = useMemo(() => {
    const m = new Map<number, DetailEpisodeTitle>();
    for (const t of episodeTitles) {
      if (typeof t.episode === "number") m.set(t.episode, t);
    }
    return m;
  }, [episodeTitles]);

  if (!episodes || episodes <= 0) return null;

  const total = episodes;
  const currentEp = sub?.currentEpisode ?? 0;
  const isCompleted = sub?.status === "completed";

  const cells: { n: number; title: string }[] = [];
  for (let n = 1; n <= total; n += 1) {
    const t = titleByEpisode.get(n);
    const title = t
      ? lang === "zh"
        ? t.nameCn || t.name || ""
        : t.name || t.nameCn || ""
      : "";
    cells.push({ n, title });
  }

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <h2 style={sectionLabelStyle}>{dict.detail.episodes}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(88px, 1fr))",
          gap: 10,
        }}
      >
        {cells.map((cell) => {
          // Legacy EpisodeList.jsx logic:
          //   watched = completed
          //          || (currentEp > 0 && ep < currentEp)
          //          || (currentEp >= total && ep <= currentEp)
          //   isCurrent = !completed && currentEp > 0
          //            && ep === currentEp && currentEp < total
          const watched =
            isCompleted ||
            (currentEp > 0 && cell.n < currentEp) ||
            (currentEp > 0 && currentEp >= total && cell.n <= currentEp);
          const isCurrent =
            !isCompleted &&
            currentEp > 0 &&
            cell.n === currentEp &&
            currentEp < total;
          const isOpen = openEp === cell.n;

          let bg = "rgba(255,255,255,0.04)";
          let border = "#38383a";
          let numColor = "rgba(235,235,245,0.60)";
          if (isCurrent) {
            bg = "rgba(10,132,255,0.20)";
            border = "rgba(10,132,255,0.50)";
            numColor = "#0a84ff";
          } else if (watched) {
            bg = "rgba(48,209,88,0.12)";
            border = "rgba(48,209,88,0.30)";
            numColor = "#30d158";
          }
          // Open-panel highlight overrides current/watched (legacy parity).
          if (isOpen) {
            bg = "rgba(10,132,255,0.12)";
            border = "rgba(10,132,255,0.55)";
            numColor = "#0a84ff";
          }

          return (
            <div
              key={cell.n}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() =>
                setOpenEp((prev) => (prev === cell.n ? null : cell.n))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenEp((prev) => (prev === cell.n ? null : cell.n));
                }
              }}
              style={{
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: 10,
                padding: "10px 8px 8px",
                textAlign: "center",
                minWidth: 0,
                cursor: "pointer",
                transition: "background 200ms, border-color 200ms",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "rgba(235,235,245,0.30)",
                  marginBottom: 3,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {dict.detail.ep}
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  color: numColor,
                  lineHeight: 1,
                  marginBottom: watched || isCurrent || cell.title ? 5 : 0,
                  fontFamily: "'Sora', sans-serif",
                }}
              >
                {cell.n}
              </div>
              {watched && (
                <div
                  style={{ fontSize: 12, color: "#30d158", marginBottom: 2 }}
                >
                  ✓
                </div>
              )}
              {isCurrent && (
                <div
                  style={{
                    fontSize: 10,
                    color: "#0a84ff",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    marginBottom: 2,
                  }}
                >
                  ▶
                </div>
              )}
              {cell.title && (
                <div
                  title={cell.title}
                  style={{
                    fontSize: 9,
                    color: "rgba(235,235,245,0.35)",
                    marginTop: 2,
                    lineHeight: 1.2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cell.title}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Legacy parity: click-to-expand panel under the grid, one episode
          at a time. (DanmakuSection — the legacy panel's live-danmaku half
          — is still deferred; it needs the ws-server socket hooks.) */}
      {openEp !== null && (
        <div
          style={{
            marginTop: 16,
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid #38383a",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <EpisodeComments
            anilistId={anilistId}
            episode={openEp}
            dict={dict}
            lang={lang}
          />
        </div>
      )}
    </section>
  );
}
