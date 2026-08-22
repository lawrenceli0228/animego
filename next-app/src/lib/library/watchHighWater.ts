// Collapses a series' per-episode progress rows into what the server stores:
// the SET of main episodes the reader has finished, and — derived from it —
// the single integer `subscription.current_episode`.
//
// The set is the primary answer and the integer is `max(set)`, which is the
// same relationship migration 0024 established server-side
// (`current_episode = COALESCE(MAX(episode), 0)` over `episode_watches`).
// Deriving one from the other here, rather than computing them independently,
// is what keeps the client incapable of describing a state the server cannot
// hold.
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
 * Every main-episode number the user has finished in this series, ascending
 * and without duplicates.
 *
 * Duplicates are real, not theoretical: a merged card draws progress from
 * several `Series` rows, and two of them can hold the same episode number
 * from different releases. The server would collapse them anyway
 * (`episode_watches`' primary key is (user, anime, episode)), so collapsing
 * them here keeps the request describing the same set the row will hold.
 *
 * Ascending order is not cosmetic either — it is what makes the last element
 * the high-water mark, and what makes two sets comparable by eye in a test
 * failure.
 *
 * Input order is irrelevant, and progress rows pointing at episodes that no
 * longer exist are skipped rather than throwing.
 */
export function resolveWatchedEpisodes(
  progress: readonly HighWaterProgress[],
  episodes: EpisodeLookup,
): number[] {
  const byId = indexById(episodes);
  const numbers = new Set<number>();

  for (const row of progress) {
    if (row?.completed !== true) continue;

    const episode = byId.get(row.episodeId);
    // A progress row can outlive its episode (rescan, split, merge).
    if (!episode) continue;
    if (episode.kind !== MAIN_KIND) continue;
    // A NaN would poison every comparison into never matching, and an
    // Infinity would win them all forever. Neither is an episode the server
    // can store, so neither belongs in a request body.
    if (!Number.isFinite(episode.number)) continue;

    numbers.add(episode.number);
  }

  return [...numbers].sort((a, b) => a - b);
}

/**
 * Highest main-episode number the user has finished in this series.
 *
 * Returns `null` — never `0` — when nothing qualifies, so the caller can tell
 * "watched nothing yet" apart from a real episode 0.
 *
 * Derived from `resolveWatchedEpisodes` rather than computed alongside it:
 * two independent passes over the same rows is two chances to disagree about
 * which episodes count, and this number's entire meaning is "the maximum of
 * that set".
 *
 * NO PRODUCTION CALLER SINCE THE RECONCILER STARTED PUSHING SETS, and that is
 * deliberate rather than an oversight — so nobody has to decide again. It is
 * the client-side statement of the invariant the whole feature rests on
 * (`subscriptions.current_episode == COALESCE(MAX(episode), 0)` over
 * `episode_watches`), it is four lines, and the test that pins it equal to the
 * set's last element is what would catch the two drifting apart if a caller
 * ever wants the number again. Same reasoning, and the same shape, as
 * `ListWatchedEpisodes` in `go-api/internal/db/queries/subscriptions.sql`,
 * which no handler calls either.
 */
export function resolveHighWater(
  progress: readonly HighWaterProgress[],
  episodes: EpisodeLookup,
): number | null {
  const watched = resolveWatchedEpisodes(progress, episodes);
  return watched.length ? watched[watched.length - 1] : null;
}
