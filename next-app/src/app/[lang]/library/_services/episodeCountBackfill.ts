// One-shot batch fill of `Series.totalEpisodes` for series that are already
// bound to AniList.
//
// WHY THE BINDING PATH CANNOT DO THIS ON ITS OWN
//
// `resolveSeriesBinding` writes a total when it resolves a binding, but its
// first branch is:
//
//     if (bound && !opts.force) return { anilistId, outcome: "existing", hit: null };
//
// Every series in an existing library is already bound, so that branch returns
// no hit and therefore no episode data — for those series the write site is
// simply never reached. `refreshSeriesMetadata` does not close the gap either:
// it re-asks dandanplay per series, one round trip each, and only for series
// that still have a hashed fileRef. So a library that predates this change
// would show a blank episode count forever.
//
// `GET /api/anime/episodes?ids=…` exists for exactly this: one bounded read of
// our own anime cache, no auth, up to 200 ids per call.
//
// WHAT "ABSENT" MEANS
//
// Ids with no cached row do not come back at all — they are not null-padded.
// Absent therefore means "not cached here", which is a different fact from
// "this show has zero episodes", and neither one is ever written as 0. Every
// reader downstream treats `<= 0` as unknown, so a stored 0 would be
// indistinguishable from absent while still costing a write and a liveQuery
// re-render.
//
// WHY THE MISS SET IS NOT PERSISTED
//
// `watchSync.ts` argues this exact point for its attempt ceiling and the
// argument holds here: the loop that had to die is the one INSIDE a session.
// The trigger below re-fires on every `db.series` write (import, rematch,
// metadata refresh, and this module's own writes), so without a negative cache
// an id the backend does not know would be re-requested on every emission,
// forever, for as long as the tab is open. A module-level Set ends that.
//
// Across a reload it deliberately asks once more, and that is the correct
// behaviour rather than a concession: the answer can change — the anime cache
// backfills, and a series the server had never heard of last week is exactly
// the one whose count should appear now. The cost of asking again is one
// request that the endpoint's own `max-age=300, stale-while-revalidate=3600`
// usually serves without touching the origin. The alternative is a second
// persisted source of truth for "is this series knowable", which is precisely
// the stale row watchSync refused to introduce.

/** The server's hard cap. More than this in one call is a 400, not a truncation. */
export const EPISODE_COUNT_ID_CAP = 200;

/** The `Series` fields this module reads. */
export interface BackfillSeriesRow {
  readonly id?: string;
  readonly anilistId?: number | null;
  readonly totalEpisodes?: number | null;
}

/** One row of `GET /api/anime/episodes`' data array. */
export interface EpisodeCountItem {
  readonly anilistId?: number;
  /** AniList's authoritative count. */
  readonly episodes?: number | null;
  /** Inferred from an external source. Fine for this UI, never for JSON-LD. */
  readonly episodesBgm?: number | null;
}

/** Injectable so tests never touch the network. */
export type EpisodeCountFetch = (
  ids: readonly number[],
) => Promise<readonly EpisodeCountItem[]>;

/** The Dexie surface this module writes. Structural, like every sibling service. */
export interface EpisodeCountDb {
  series: {
    update(id: string, changes: Record<string, unknown>): Promise<unknown>;
  };
}

export interface BackfillSummary {
  /** Distinct AniList ids actually asked about. */
  readonly requested: number;
  /** Series rows that got a `totalEpisodes`. */
  readonly written: number;
  /** Ids the endpoint had no usable count for; not asked again this session. */
  readonly unknown: number;
  /** A chunk that failed. Its ids stay eligible for the next run. */
  readonly failedChunks: number;
}

const EMPTY: BackfillSummary = {
  requested: 0,
  written: 0,
  unknown: 0,
  failedChunks: 0,
};

/**
 * AniList ids this session asked about and got no usable count for.
 *
 * Not persisted — see the header. Keyed by AniList id rather than series id
 * because the answer is a property of the title, not of the local row, so two
 * series bound to the same id share one answer.
 */
const _unknownIds = new Set<number>();

/** Test seam. */
export function resetEpisodeCountBackfillCache(): void {
  _unknownIds.clear();
}

/** Positive integer or nothing. The API's JSON is untrusted input. */
function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Which of the two counts to store, in the order the plan fixes:
 * AniList's authoritative `episodes` first, the inferred `episodesBgm` only as
 * a fallback.
 *
 * The two stay two fields on the wire on purpose — a downstream consumer emits
 * `numberOfEpisodes` into schema.org JSON-LD and only the authoritative value
 * may appear there. Choosing between them is the caller's job, and this caller
 * is a local, private episode grid, so the inferred value is welcome here.
 */
export function pickTotalEpisodes(
  episodes: unknown,
  episodesBgm: unknown,
): number | undefined {
  return positiveInt(episodes) ?? positiveInt(episodesBgm);
}

/**
 * The AniList ids worth asking about, in stable order, each one once.
 *
 * A series qualifies when it is bound (there is an id to ask with) and has no
 * usable total yet. Ids already answered "not cached" this session are dropped
 * here rather than at the response, so a re-run costs nothing at all.
 */
export function collectBackfillIds(
  series: readonly BackfillSeriesRow[] | null | undefined,
  skip: ReadonlySet<number> = _unknownIds,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const row of series ?? []) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    if (positiveInt(row.totalEpisodes) !== undefined) continue;
    const anilistId = positiveInt(row.anilistId);
    if (anilistId === undefined) continue;
    if (skip.has(anilistId) || seen.has(anilistId)) continue;
    seen.add(anilistId);
    out.push(anilistId);
  }
  return out;
}

/**
 * Split ids into request-sized batches. The cap is the server's, not a
 * preference: 201 ids is a 400 for the whole call, so a library one series over
 * the line would get nothing rather than a short answer.
 */
export function chunkIds(
  ids: readonly number[],
  size: number = EPISODE_COUNT_ID_CAP,
): number[][] {
  const limit = Number.isInteger(size) && size > 0 ? size : EPISODE_COUNT_ID_CAP;
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += limit) {
    out.push(ids.slice(i, i + limit));
  }
  return out;
}

/** Throws on a non-2xx so the caller can tell "no answer" from "no count". */
export async function fetchEpisodeCounts(
  ids: readonly number[],
): Promise<readonly EpisodeCountItem[]> {
  const res = await fetch(`/api/anime/episodes?ids=${ids.join(",")}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`fetchEpisodeCounts: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: readonly EpisodeCountItem[] } | null;
  return body?.data ?? [];
}

export interface BackfillInput {
  readonly db: EpisodeCountDb;
  /** Every Series row in the library — merged-away sources included. */
  readonly series: readonly BackfillSeriesRow[] | null | undefined;
  /** Injected in tests; defaults to the real endpoint. */
  readonly fetchCounts?: EpisodeCountFetch;
}

/**
 * Fill in `totalEpisodes` for every bound series that has none.
 *
 * NEVER THROWS. The caller is a fire-and-forget effect on a page that has
 * already rendered; a chunk that fails leaves its ids eligible for the next run
 * and costs the user nothing visible.
 *
 * Idempotent: the candidate list is derived from the rows themselves, so a
 * series that got its total drops out on the next pass, and one that came back
 * unknown is remembered for the rest of the session.
 */
export async function backfillEpisodeCounts(
  input: BackfillInput,
): Promise<BackfillSummary> {
  const { db, series, fetchCounts = fetchEpisodeCounts } = input;
  if (!db?.series) return EMPTY;

  const ids = collectBackfillIds(series);
  if (ids.length === 0) return EMPTY;

  // anilistId → the series rows bound to it. Two local rows can legitimately
  // share one id (a manual rematch onto a show already in the library), and
  // both deserve the answer.
  const seriesIdsByAnilistId = new Map<number, string[]>();
  for (const row of series ?? []) {
    const seriesId = row?.id;
    const anilistId = positiveInt(row?.anilistId);
    if (!seriesId || anilistId === undefined) continue;
    if (positiveInt(row?.totalEpisodes) !== undefined) continue;
    const bucket = seriesIdsByAnilistId.get(anilistId);
    if (bucket) bucket.push(seriesId);
    else seriesIdsByAnilistId.set(anilistId, [seriesId]);
  }

  let written = 0;
  let unknown = 0;
  let failedChunks = 0;

  for (const chunk of chunkIds(ids)) {
    let items: readonly EpisodeCountItem[];
    try {
      items = await fetchCounts(chunk);
    } catch (err) {
      // Deliberately NOT latched as unknown: a dropped request is not an answer
      // about these titles, and remembering it would disable the backfill for
      // the session over one bad network moment. Same rule as
      // resolveSeriesBinding's search failure.
      failedChunks += 1;
      console.warn(
        "[episodeCountBackfill] chunk failed:",
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    const answered = new Set<number>();
    for (const item of items ?? []) {
      const anilistId = positiveInt(item?.anilistId);
      if (anilistId === undefined) continue;
      answered.add(anilistId);
      const total = pickTotalEpisodes(item?.episodes, item?.episodesBgm);
      if (total === undefined) {
        // Cached, but with nothing to say — an airing show with no announced
        // length. Same handling as absent: do not ask again this session, and
        // never write a 0 that would read as a real answer.
        _unknownIds.add(anilistId);
        unknown += 1;
        continue;
      }
      for (const seriesId of seriesIdsByAnilistId.get(anilistId) ?? []) {
        try {
          // No `updatedAt` bump. The "new additions" row sorts on it and
          // learning a series' length is not the user adding anything —
          // `writeBinding` withholds the same bump for the same reason.
          await db.series.update(seriesId, { totalEpisodes: total });
          written += 1;
        } catch (err) {
          console.warn(
            "[episodeCountBackfill] write failed:",
            seriesId,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    for (const anilistId of chunk) {
      if (answered.has(anilistId)) continue;
      // Absent from the response = not in the anime cache at all.
      _unknownIds.add(anilistId);
      unknown += 1;
    }
  }

  return { requested: ids.length, written, unknown, failedChunks };
}
