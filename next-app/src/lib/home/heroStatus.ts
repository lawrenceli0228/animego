// The hero's status line: "连载中 · 周日 19:00 更新第 14 集", "已完结 · 共 12 集".
//
// The next-airing time is only known for shows inside /api/anime/schedule's
// seven-day window, so the airing part is optional and the status stands on
// its own without it. Formatting of the time is injected: the hero renders it
// in the site's zone during hydration and the browser's afterwards.
//
// Pure: no DOM, no React.

import { fillTemplate } from "./time";

export interface Airing {
  /** Epoch ms. */
  at: number;
  ep: number;
}

/** The first episode strictly after now; one airing this minute has gone out. */
export function upcomingAiring(airings: readonly Airing[], nowMs: number): Airing | null {
  let best: Airing | null = null;
  for (const a of airings) {
    if (a.at <= nowMs) continue;
    if (!best || a.at < best.at) best = a;
  }
  return best;
}

export interface StatusCopy {
  /** "更新第 {{ep}} 集" */
  epUpdate: string;
  /** "共 {{n}} 集" */
  totalEps: string;
}

export interface StatusInput {
  /** Raw AniList enum: RELEASING, FINISHED, NOT_YET_RELEASED, … */
  status: string | null;
  /** Already localised by the caller (contentLabels.statusLabel). */
  statusLabel: string;
  episodes: number | null;
  airings: readonly Airing[];
}

export interface StatusParts {
  label: string;
  /** Formatted next-airing time, when one is known and still ahead. */
  when: string | null;
  /** The episode being aired next, or the total for a finished show. */
  detail: string | null;
  /** Currently airing — the dot pings. */
  live: boolean;
}

export function heroStatusParts(
  input: StatusInput,
  nowMs: number,
  formatWhen: (ms: number) => string,
  copy: StatusCopy,
): StatusParts {
  const live = input.status === "RELEASING";
  if (input.status === "FINISHED") {
    const total = input.episodes && input.episodes > 0 ? fillTemplate(copy.totalEps, { n: input.episodes }) : null;
    return { label: input.statusLabel, when: null, detail: total, live: false };
  }
  const next = upcomingAiring(input.airings, nowMs);
  if (!next) return { label: input.statusLabel, when: null, detail: null, live };
  return {
    label: input.statusLabel,
    when: formatWhen(next.at),
    detail: fillTemplate(copy.epUpdate, { ep: next.ep }),
    live,
  };
}

/**
 * Join the parts into one line. `short` drops the episode detail when a time
 * is shown — the narrow hero has room for "连载中 · 周日 19:00" and no more.
 */
export function statusText(parts: StatusParts, opts: { short?: boolean } = {}): string {
  if (!parts.label) return "";
  if (parts.when) {
    return opts.short || !parts.detail
      ? `${parts.label} · ${parts.when}`
      : `${parts.label} · ${parts.when} ${parts.detail}`;
  }
  return parts.detail ? `${parts.label} · ${parts.detail}` : parts.label;
}
