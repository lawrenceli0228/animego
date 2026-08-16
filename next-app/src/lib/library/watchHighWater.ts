// Collapses a series' per-episode progress rows into the single integer
// high-water mark the server tracks as `subscription.current_episode`.
//
// Two rules carry all the weight:
//
//  1. Only `kind === 'main'` counts (design doc decision 10). `episodeParser`
//     pulls a number out of the filename regardless of type, so `[NCOP01]`
//     lands as `{ kind: 'ncop', number: 1 }`. Counting it would push the
//     high-water mark to episode 1 for a series the user never started, and
//     with the server-side GREATEST guard in place that value can never be
//     walked back down.
//
//  2. No upper bound is applied here. Design doc §6.1 (T4) moves the bound to
//     the server, which holds the authoritative `anime_cache.episodes` and
//     rejects an out-of-range value with a 400. The client's
//     `Series.totalEpisodes` is optional and frequently wrong, so bounding
//     against it would silently drop legitimate pushes. (The §8.1 coverage
//     diagram still lists a `> totalEpisodes → 不推` branch; that line is a
//     leftover from the first draft and §6.1 supersedes it.)
//
// Deliberately pure: no DOM, no Dexie, no React. `src/testImportHygiene.test.ts`
// depends on that staying true.

/** The `Progress` fields this module reads. See `types.js` `Progress` typedef. */
export interface HighWaterProgress {
  /** ULID pointing at `Episode.id` — NOT the dandanplay `Episode.episodeId`. */
  readonly episodeId: string;
  readonly completed?: boolean;
}

/** The `Episode` fields this module reads. See `types.js` `Episode` typedef. */
export interface HighWaterEpisode {
  /** ULID primary key, the value `Progress.episodeId` refers to. */
  readonly id: string;
  readonly number: number;
  /** One of 14 values; only `'main'` participates in sync. */
  readonly kind: string;
}

/** Episodes as a flat list, or as a prebuilt `Episode.id` → episode index. */
export type EpisodeLookup =
  | readonly HighWaterEpisode[]
  | ReadonlyMap<string, HighWaterEpisode>;

const MAIN_KIND = "main";

function indexById(episodes: EpisodeLookup): ReadonlyMap<string, HighWaterEpisode> {
  if (!Array.isArray(episodes)) {
    return episodes as ReadonlyMap<string, HighWaterEpisode>;
  }
  return new Map(episodes.map((episode) => [episode.id, episode]));
}

/**
 * Highest main-episode number the user has finished in this series.
 *
 * Returns `null` — never `0` — when nothing qualifies, so the caller can tell
 * "watched nothing yet" apart from a real episode 0. Input order is irrelevant,
 * and progress rows pointing at episodes that no longer exist are skipped
 * rather than throwing.
 */
export function resolveHighWater(
  progress: readonly HighWaterProgress[],
  episodes: EpisodeLookup,
): number | null {
  const byId = indexById(episodes);
  let highest: number | null = null;

  for (const row of progress) {
    if (row?.completed !== true) continue;

    const episode = byId.get(row.episodeId);
    // A progress row can outlive its episode (rescan, split, merge).
    if (!episode) continue;
    if (episode.kind !== MAIN_KIND) continue;
    // A NaN number would poison the comparison into never matching, and an
    // Infinity would win it forever. Neither belongs in a PATCH body.
    if (!Number.isFinite(episode.number)) continue;

    if (highest === null || episode.number > highest) highest = episode.number;
  }

  return highest;
}
