"use client";

// One-shot batch fill of `Series.episodeRuleOffsets`: anime-relations' curated
// shifts for a series (see `lib/library/episodeOffset` and go-api's
// internal/animerelations).
//
// A sibling of `episodeOffsetBackfill`, not a branch of it. That sweep asks
// for series WITHOUT an `episodeOffset`, and nearly every series already in a
// library has one — so the new field would reach nobody through it. This one
// asks by the new field alone, against the same endpoint.
//
// `[]` is written for an id the answer carries no rule for: it is a known
// answer ("the curated file has nothing for this season"), and storing it is
// what keeps the sweep from asking again on every page load.
//
// `rules=1` on the request is not read by the server. It gives the response a
// cache key of its own, so a browser or CDN copy cached before the server
// started sending `ruleOffsets` cannot be read as "no rules" and stored.

import { readRuleOffsets } from "@/lib/library/episodeOffset";
import { chunkIds, EPISODE_COUNT_ID_CAP } from "./episodeCountBackfill";

export interface RuleOffsetBackfillSeriesRow {
  readonly id?: string;
  readonly anilistId?: number | null;
  readonly episodeRuleOffsets?: unknown;
  readonly [key: string]: unknown;
}

export interface RuleOffsetItem {
  readonly anilistId?: number;
  readonly known?: boolean;
  readonly offset?: number;
  readonly ruleOffsets?: readonly number[];
}

export type RuleOffsetFetch = (ids: readonly number[]) => Promise<readonly RuleOffsetItem[]>;

export interface RuleOffsetDb {
  readonly series: {
    update(id: string, changes: Record<string, unknown>): Promise<unknown>;
  };
}

export interface RuleOffsetBackfillSummary {
  readonly asked: number;
  readonly written: number;
  readonly failedChunks: number;
}

const EMPTY: RuleOffsetBackfillSummary = { asked: 0, written: 0, failedChunks: 0 };

/** Ids answered this session, so a write that failed is not retried in a loop. */
const _answeredIds = new Set<number>();

/** Test hook. */
export function resetEpisodeRuleOffsetBackfillCache(): void {
  _answeredIds.clear();
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function needsRules(row: RuleOffsetBackfillSeriesRow | null | undefined): boolean {
  return readRuleOffsets(row?.episodeRuleOffsets) === undefined;
}

/** Bound series without the field, one entry per AniList id. */
export function collectRuleOffsetBackfillIds(
  series: readonly RuleOffsetBackfillSeriesRow[] | null | undefined,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const row of series ?? []) {
    if (!row || typeof row.id !== "string" || !row.id || !needsRules(row)) continue;
    const anilistId = positiveInt(row.anilistId);
    if (anilistId === undefined || seen.has(anilistId) || _answeredIds.has(anilistId)) continue;
    seen.add(anilistId);
    out.push(anilistId);
  }
  return out;
}

/** Throws on a non-2xx so a failed chunk is not read as "no rules". */
export async function fetchRuleOffsets(ids: readonly number[]): Promise<readonly RuleOffsetItem[]> {
  const res = await fetch(`/api/anime/episode-offsets?ids=${ids.join(",")}&rules=1`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`fetchRuleOffsets: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: readonly RuleOffsetItem[] } | null;
  return body?.data ?? [];
}

/**
 * Fill in `episodeRuleOffsets` for every bound series that has none.
 * NEVER THROWS — a fire-and-forget effect on a page that has rendered.
 */
export async function backfillEpisodeRuleOffsets(input: {
  readonly db: RuleOffsetDb;
  readonly series: readonly RuleOffsetBackfillSeriesRow[] | null | undefined;
  readonly fetchOffsets?: RuleOffsetFetch;
}): Promise<RuleOffsetBackfillSummary> {
  const { db, series, fetchOffsets = fetchRuleOffsets } = input;
  if (!db?.series) return EMPTY;
  const ids = collectRuleOffsetBackfillIds(series);
  if (ids.length === 0) return EMPTY;

  const seriesIdsByAnilistId = new Map<number, string[]>();
  for (const row of series ?? []) {
    const anilistId = positiveInt(row?.anilistId);
    if (!row?.id || anilistId === undefined || !needsRules(row)) continue;
    seriesIdsByAnilistId.set(anilistId, [...(seriesIdsByAnilistId.get(anilistId) ?? []), row.id]);
  }

  let written = 0;
  let failedChunks = 0;
  for (const chunk of chunkIds(ids, EPISODE_COUNT_ID_CAP)) {
    let items: readonly RuleOffsetItem[];
    try {
      items = await fetchOffsets(chunk);
    } catch (err) {
      failedChunks += 1;
      console.warn("[episodeRuleOffsetBackfill] chunk failed:", err instanceof Error ? err.message : err);
      continue;
    }
    const rulesById = new Map<number, number[]>();
    for (const item of items) {
      const anilistId = positiveInt(item?.anilistId);
      if (anilistId !== undefined) rulesById.set(anilistId, readRuleOffsets(item?.ruleOffsets) ?? []);
    }
    for (const anilistId of chunk) {
      _answeredIds.add(anilistId);
      const ruleOffsets = rulesById.get(anilistId) ?? [];
      for (const seriesId of seriesIdsByAnilistId.get(anilistId) ?? []) {
        try {
          // Not bumping `updatedAt`: the "new additions" row sorts on it.
          await db.series.update(seriesId, { episodeRuleOffsets: ruleOffsets });
          written += 1;
        } catch (err) {
          console.warn(
            "[episodeRuleOffsetBackfill] write failed for",
            seriesId,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }
  return { asked: ids.length, written, failedChunks };
}
