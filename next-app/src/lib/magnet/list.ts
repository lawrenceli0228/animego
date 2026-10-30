// The magnet panel's list: rows built once from the API answer, then cut by
// the subtitle filter and the release-group strip.
//
// The order is the server's (seeders, then date, then source) and nothing
// here re-ranks it: the panel is an index, not a recommendation, so no row is
// lifted, pinned or labelled as better than another.
//
// Pure: no React, no DOM.

import { formatReleaseDate, formatSize } from "./format";
import {
  cleanFansub,
  parseRelease,
  titleWithoutGroup,
  type ReleaseEpisode,
  type ReleaseFacts,
  type SubtitleScript,
} from "./release";

/** One row of GET /api/anime/torrents, as go-api sends it. */
export interface TorrentItem {
  title: string;
  magnet: string;
  size: string;
  fansub: string | null;
  date: string | null;
  source: string;
  seeders?: number | null;
  infohash?: string;
  provider?: string | null;
}

export interface MagnetRow {
  /** Stable React key: the infohash, else the magnet, made unique. */
  key: string;
  /** The release group, cleaned; "" when the title names none. */
  fansub: string;
  /** The title as shown: the full title, less a leading bracket that repeats the group. */
  title: string;
  facts: ReleaseFacts;
  /** "6.6 GB", or "" when the source gave no usable size. */
  size: string;
  /** "2026-08-22", or "". */
  date: string;
  /** The source id ("dmhy", "garden", …); the panel names it. */
  source: string;
  magnet: string;
}

export function toRows(items: readonly TorrentItem[]): MagnetRow[] {
  const seen = new Map<string, number>();
  return items
    .filter((item) => typeof item?.title === "string" && typeof item.magnet === "string")
    .map((item) => {
      const base = item.infohash || item.magnet;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const fansub = cleanFansub(item.fansub);
      return {
        key: n === 0 ? base : `${base}#${n}`,
        fansub,
        title: titleWithoutGroup(item.title, fansub),
        facts: parseRelease(item.title),
        size: formatSize(item.size),
        date: formatReleaseDate(item.date),
        source: item.source,
        magnet: item.magnet,
      };
    });
}

// ── Subtitle filter ──────────────────────────────────────────────────

export type SubFilter = "all" | "simp" | "trad" | "both";

export const SUB_FILTERS: readonly SubFilter[] = ["all", "simp", "trad", "both"];

/**
 * 简体 also lists 简繁 releases and 繁体 likewise — a release carrying both
 * scripts serves either reader. 简繁 lists only releases carrying both.
 */
export function matchesSubFilter(script: SubtitleScript | null, filter: SubFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "simp":
      return script === "simp" || script === "both";
    case "trad":
      return script === "trad" || script === "both";
    case "both":
      return script === "both";
  }
}

// ── Release-group strip ──────────────────────────────────────────────

export interface FansubCell {
  /** null is "all groups"; "" is the rows that name no group. */
  key: string | null;
  count: number;
}

/**
 * "All" first, then every group with rows under the subtitle filter, most
 * rows first; equal counts keep the order the groups first appear in the
 * list. A selected group the filter has emptied stays in the strip with 0,
 * so the reader can see what the list is cut to.
 */
export function fansubCells(
  rows: readonly MagnetRow[],
  filter: SubFilter,
  selected: string | null,
): FansubCell[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    if (!matchesSubFilter(row.facts.script, filter)) continue;
    total += 1;
    counts.set(row.fansub, (counts.get(row.fansub) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .map(([key, count], order) => ({ key, count, order }))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ key, count }) => ({ key, count }));
  const cells: FansubCell[] = [{ key: null, count: total }, ...groups];
  if (selected !== null && !counts.has(selected)) cells.push({ key: selected, count: 0 });
  return cells;
}

export function visibleRows(
  rows: readonly MagnetRow[],
  filter: SubFilter,
  fansub: string | null,
): MagnetRow[] {
  return rows.filter(
    (row) => matchesSubFilter(row.facts.script, filter) && (fansub === null || row.fansub === fansub),
  );
}

// ── Episode tag ──────────────────────────────────────────────────────

/**
 * The episode a row's tag shows, in the season's own numbering.
 *
 * Groups often number across seasons: season 2's finale is "[38]" when season
 * 1 ran 28. With the season's length known, a number past it is translated
 * by the franchise offset when that lands inside the season (38 − 28 = 10),
 * and otherwise shows no tag — a number the season cannot have is not one to
 * print. With the length unknown (still airing) a number past the offset
 * could be either — a long season's own 13 or a continuous 13 after 11 — so
 * it shows no tag; numbers up to the offset are the season's own.
 *
 * `offset` is the measured offset or undefined when unknown; 0 is a real
 * answer ("nothing precedes this season") and translates nothing.
 */
export function episodeLabel(
  episode: ReleaseEpisode,
  seasonEpisodes: number | null,
  offset: number | undefined,
): ReleaseEpisode {
  if (episode === null || episode.kind === "batch") return episode;
  const { n } = episode;
  const shift = offset !== undefined && offset > 0 ? offset : 0;
  if (seasonEpisodes !== null && Number.isInteger(seasonEpisodes) && seasonEpisodes > 0) {
    if (n <= seasonEpisodes) return episode;
    const local = n - shift;
    return shift > 0 && local >= 1 && local <= seasonEpisodes ? { kind: "single", n: local } : null;
  }
  return shift > 0 && n > shift ? null : episode;
}
