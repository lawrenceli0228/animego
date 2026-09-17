"use client";

// The hero's next-episode strip: "第 1179 集 · 9月20日 周日 22:16 · 3 天后".
//
// A client leaf for two reasons the server cannot get right on its own:
//
//   - The clock. /anime/[id] is ISR behind Cloudflare, and the edge copy can
//     be hours old; a relative time baked into it would be stated as news
//     while quietly wrong. So the server renders the episode and the
//     absolute time only, and the relative part is computed here once the
//     client has a clock, and kept current by the minute.
//   - The time zone. The absolute time is rendered in Asia/Shanghai on the
//     server and during hydration (so the two agree and there is nothing to
//     suppress), then in the browser's own zone. The site's schedule widget
//     makes the same choice.
//
// The labels arrive as props: this file must not read the server
// dictionaries, and the client-side ones (`*-spa.js`) are the wrong layer
// for copy the server already resolved.

import { useSyncExternalStore } from "react";
import { airsIn, type AiringCopy } from "@/components/anime/airsIn";
import styles from "./NextAiringBadge.module.css";

/** The zone the server renders in; also the schedule widget's "today". */
const SERVER_TZ = "Asia/Shanghai";
/** How often the relative part is recomputed while the page is open. */
const TICK_MS = 60_000;

export interface NextAiringBadgeProps {
  /** ISO instant of the next episode, as AniList last stated it. */
  airingAt: string;
  episode: number;
  /** BCP 47 tag for Intl — the page's language, not the browser's. */
  bcp47: string;
  copy: AiringCopy;
}

function formatAbsolute(ms: number, bcp47: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat(bcp47, {
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(ms));
}

function subscribeMinute(onChange: () => void): () => void {
  const id = setInterval(onChange, TICK_MS);
  return () => clearInterval(id);
}

/**
 * The clock, as an external store: the current minute on the client, 0 on
 * the server and during hydration. Zero is "unknown" — the server's answer
 * to anything time-relative is not to give one — and once React has
 * hydrated against it, the client snapshot differs and the badge re-renders
 * with a real clock. No effect, no setState, nothing to reconcile.
 */
function useClientMinute(): number {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / TICK_MS),
    () => 0,
  );
}

export default function NextAiringBadge({ airingAt, episode, bcp47, copy }: NextAiringBadgeProps) {
  const airingMs = new Date(airingAt).getTime();
  const minute = useClientMinute();
  const onClient = minute !== 0;

  if (!Number.isFinite(airingMs)) return null;
  const relative = onClient ? airsIn(airingMs, minute * TICK_MS, copy) : null;
  // The server never renders a past episode (see upcomingEpisode in the
  // page); the client re-checks against its own clock and hides the strip
  // the minute it passes.
  if (onClient && relative === null) return null;
  const absolute = formatAbsolute(airingMs, bcp47, onClient ? undefined : SERVER_TZ);

  return (
    <p className={styles.badge}>
      <span className={styles.episode}>{copy.nextEpisode.split("{{ep}}").join(String(episode))}</span>
      <time dateTime={airingAt} className={styles.when}>
        {absolute}
      </time>
      {relative ? <span className={styles.relative}>{relative}</span> : null}
    </p>
  );
}
