"use client";

// One-shot batch fill of `Series.episodeOffset` for series that are already
// bound.
//
// WHY THIS MODULE HAS TO EXIST
//
// `resolveSeriesBinding` fetches the offset when it resolves a binding, and
// that path returns early for a series that is already bound — the same
// ceiling its `persistEpisodeTotal` call has, and the reason
// `episodeCountBackfill` exists beside it. Without a sweep, the fix that
// motivated the offset would reach nobody who already had the affected series
// in their library, which is everybody who could report it.
//
// It is deliberately the same shape as `episodeCountBackfill`: same trigger,
// same rows, same cap, same fire-and-forget contract. Two sweeps rather than
// one because the candidate sets differ — a series can have its total and not
// its offset, or the reverse — and merging them would re-ask for whichever
// half was already answered.
//
// ─── the predicate that is easy to get wrong ────────────────────────────────
//
// "Already has an offset" is `typeof x === "number"`, NOT `x > 0`.
//
// 0 is a real answer: it means nothing precedes this season, and it is the
// answer for most of the catalogue. Testing for a positive value would leave
// every standalone series permanently eligible, so each sweep would re-ask for
// the same rows forever and never drain — the stall that migrations 0015 and
// 0023 both landed on server-side, arriving here through the same door.

import { chunkIds, EPISODE_COUNT_ID_CAP } from "./episodeCountBackfill";

export interface OffsetBackfillSeriesRow {
  readonly id?: string;
  readonly anilistId?: number | null;
  readonly episodeOffset?: number | null;
}

export interface EpisodeOffsetItem {
  readonly anilistId?: number;
  readonly known?: boolean;
  readonly offset?: number;
}

export type EpisodeOffsetFetch = (
  ids: readonly number[],
) => Promise<readonly EpisodeOffsetItem[]>;

export interface EpisodeOffsetDb {
  readonly series: {
    update(id: string, changes: Record<string, unknown>): Promise<unknown>;
  };
}

export interface OffsetBackfillSummary {
  readonly asked: number;
  /** Series rows that got an `episodeOffset`. */
  readonly written: number;
  /** Ids the server could not work an offset out for. */
  readonly unknown: number;
  readonly failedChunks: number;
}

const EMPTY: OffsetBackfillSummary = {
  asked: 0,
  written: 0,
  unknown: 0,
  failedChunks: 0,
};

/**
 * AniList ids this session asked about and got `known:false` for.
 *
 * Not persisted, and keyed by AniList id rather than series id: the answer is
 * a property of the title, so two local rows bound to the same id share it.
 * A reload re-asks, which is correct — the answer changes when that title's
 * detail is finally fetched and its relation rows appear.
 */
const _unknownIds = new Set<number>();

/** Test seam. */
export function resetEpisodeOffsetBackfillCache(): void {
  _unknownIds.clear();
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A stored offset, including a stored zero. See the header. */
function hasOffset(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The AniList ids worth asking about, in stable order, each one once.
 *
 * A series qualifies when it is bound and has no offset stored — where "no
 * offset" means the field is absent, not that it is zero.
 */
export function collectOffsetBackfillIds(
  series: readonly OffsetBackfillSeriesRow[] | null | undefined,
  skip: ReadonlySet<number> = _unknownIds,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const row of series ?? []) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    if (hasOffset(row.episodeOffset)) continue;
    const anilistId = positiveInt(row.anilistId);
    if (anilistId === undefined) continue;
    if (skip.has(anilistId) || seen.has(anilistId)) continue;
    seen.add(anilistId);
    out.push(anilistId);
  }
  return out;
}

/** Throws on a non-2xx so the caller can tell "no answer" from "no offset". */
export async function fetchEpisodeOffsets(
  ids: readonly number[],
): Promise<readonly EpisodeOffsetItem[]> {
  const res = await fetch(`/api/anime/episode-offsets?ids=${ids.join(",")}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`fetchEpisodeOffsets: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: readonly EpisodeOffsetItem[] } | null;
  return body?.data ?? [];
}

export interface OffsetBackfillInput {
  readonly db: EpisodeOffsetDb;
  /** Every Series row in the library — merged-away sources included. */
  readonly series: readonly OffsetBackfillSeriesRow[] | null | undefined;
  /** Injected in tests; defaults to the real endpoint. */
  readonly fetchOffsets?: EpisodeOffsetFetch;
}

/**
 * Fill in `episodeOffset` for every bound series that has none.
 *
 * NEVER THROWS. The caller is a fire-and-forget effect on a page that has
 * already rendered; a chunk that fails leaves its ids eligible for the next
 * run and costs the reader nothing visible.
 *
 * Idempotent: the candidate list is derived from the rows themselves, so a
 * series that got its offset drops out on the next pass, and one that came
 * back unknown is remembered for the rest of the session.
 */
export async function backfillEpisodeOffsets(
  input: OffsetBackfillInput,
): Promise<OffsetBackfillSummary> {
  const { db, series, fetchOffsets = fetchEpisodeOffsets } = input;
  if (!db?.series) return EMPTY;

  const ids = collectOffsetBackfillIds(series);
  if (ids.length === 0) return EMPTY;

  // anilistId → the series rows bound to it. Two local rows can legitimately
  // share one id (a manual rematch onto a show already in the library), and
  // both deserve the answer.
  const seriesIdsByAnilistId = new Map<number, string[]>();
  for (const row of series ?? []) {
    const seriesId = row?.id;
    const anilistId = positiveInt(row?.anilistId);
    if (!seriesId || anilistId === undefined) continue;
    if (hasOffset(row?.episodeOffset)) continue;
    const bucket = seriesIdsByAnilistId.get(anilistId);
    if (bucket) bucket.push(seriesId);
    else seriesIdsByAnilistId.set(anilistId, [seriesId]);
  }

  let written = 0;
  let unknown = 0;
  let failedChunks = 0;

  for (const chunk of chunkIds(ids, EPISODE_COUNT_ID_CAP)) {
    let items: readonly EpisodeOffsetItem[];
    try {
      items = await fetchOffsets(chunk);
    } catch (err) {
      failedChunks += 1;
      // NOT added to `_unknownIds`. A failed request is not an answer about
      // these titles, and latching it would make one flaky network moment
      // cost the whole sweep for the rest of the session.
       
      console.warn(
        "[episodeOffsetBackfill] chunk failed:",
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    const answered = new Set<number>();
    for (const item of items) {
      const anilistId = positiveInt(item?.anilistId);
      if (anilistId === undefined) continue;
      answered.add(anilistId);
      const offset = item?.known === true ? item.offset : undefined;
      if (!hasOffset(offset)) {
        unknown += 1;
        _unknownIds.add(anilistId);
        continue;
      }
      for (const seriesId of seriesIdsByAnilistId.get(anilistId) ?? []) {
        try {
          // Deliberately not bumping `updatedAt` — the "new additions" row
          // sorts on it, and learning where a season sits in its franchise is
          // not the reader adding anything.
          await db.series.update(seriesId, { episodeOffset: offset });
          written += 1;
        } catch (err) {
           
          console.warn(
            "[episodeOffsetBackfill] write failed for",
            seriesId,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // An id the server returned no row for is not in the cache at all. That is
    // the same answer as known:false and has to be latched the same way, or
    // every sweep re-asks for it — the response is keyed by id precisely so
    // this case is visible rather than silently absent.
    for (const id of chunk) {
      if (!answered.has(id)) {
        unknown += 1;
        _unknownIds.add(id);
      }
    }
  }

  return { asked: ids.length, written, unknown, failedChunks };
}
