"use client";

/**
 * EpisodeSidebar — the episode list beside the player.
 *
 * Replaces the row of `EP01 EP02 …` chips under the video. The chips said
 * nothing but a number, and sat below a player that already filled the
 * window, so on most screens they were not visible without scrolling. Here
 * each episode carries its title, the current one is marked and kept in
 * view, and the list takes the player's height instead of adding to it.
 *
 * Laid out by PlayerShell's grid: it fills its grid cell absolutely, so the
 * row's height is the player's and a long season scrolls inside the list.
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";

const HUE = 210;

const epHue = (ep: number) => (Number.isFinite(ep) ? (HUE + ep * 10) % 360 : HUE);

const s: Record<string, CSSProperties> = {
  wrap: {
    position: "relative",
    height: "100%",
    minHeight: 240,
    border: "1px solid rgba(235,235,245,0.08)",
    borderRadius: 6,
    background: "rgba(20,20,26,0.6)",
  },
  inner: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    padding: "12px 14px 10px",
    borderBottom: "1px solid rgba(235,235,245,0.06)",
  },
  title: { fontSize: 13, fontWeight: 600, color: "#fff" },
  count: {
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    color: "rgba(235,235,245,0.45)",
  },
  list: { flex: "1 1 auto", overflowY: "auto", padding: 6 },
  row: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "34px 1fr",
    alignItems: "center",
    gap: 10,
    padding: "9px 10px",
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: "rgba(235,235,245,0.72)",
    textAlign: "left",
    cursor: "pointer",
    font: "inherit",
  },
  num: {
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 12,
    letterSpacing: "0.06em",
    fontVariantNumeric: "tabular-nums",
  },
  epTitle: {
    fontSize: 13,
    lineHeight: 1.35,
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
};

export interface EpisodeSidebarProps {
  episodes: number[];
  currentEpisode: number | null;
  onSelect: (ep: number) => void;
  /** Episode title for a listed number, when the danmaku match knows it. */
  titleOf?: (ep: number) => string | undefined;
}

export function EpisodeSidebar({ episodes, currentEpisode, onSelect, titleOf }: EpisodeSidebarProps) {
  const { t } = useLang();
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the current episode in view, without scrolling the page itself.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row) return;
    const top = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, top) });
  }, [currentEpisode, episodes.length]);

  return (
    <nav style={s.wrap} aria-label={t("player.episodeList")} data-testid="episode-sidebar">
      <div style={s.inner}>
        <div style={s.head}>
          <span style={s.title}>{t("player.episodeList")}</span>
          <span style={s.count}>{t("player.episodeTotal").replace("{{n}}", String(episodes.length))}</span>
        </div>
        <div ref={listRef} style={s.list}>
          {episodes.map((ep) => {
            const active = ep === currentEpisode;
            const hue = epHue(ep);
            const title = titleOf?.(ep);
            return (
              <button
                key={ep}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => !active && onSelect(ep)}
                style={{
                  ...s.row,
                  background: active ? `oklch(62% 0.19 ${hue} / 0.14)` : "transparent",
                  boxShadow: active ? `inset 2px 0 0 oklch(72% 0.17 ${hue})` : "none",
                  color: active ? "#fff" : (s.row.color as string),
                  cursor: active ? "default" : "pointer",
                }}
              >
                <span style={{ ...s.num, color: active ? `oklch(82% 0.15 ${hue})` : "rgba(235,235,245,0.5)" }}>
                  {String(ep).padStart(2, "0")}
                </span>
                <span style={s.epTitle}>{title || `EP${String(ep).padStart(2, "0")}`}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export default EpisodeSidebar;
