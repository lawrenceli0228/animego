// Normalizing a search hit into a rematch payload — extracted from
// RematchDialog so the rule can be tested without mounting React.
//
// This module exists because of a bug that was firing on every pick from the
// richer half of the picker, so the extraction is not cosmetic: the rule below
// is the one thing standing between the user and a poisoned local library.
//
// The rule itself is no longer stated here. It lives in `animeIds.ts`, shared
// with `dandanClient.ts` — the automatic path, which had the identical bug and
// used to carry its own private copy of the fix.

import {
  toAnilistId,
  toDandanAnimeId,
  toPositiveInt,
  type AnilistId,
  type DandanAnimeId,
} from "./animeIds";

// Re-exported rather than redefined: this used to be the module's own helper,
// and it is part of its tested surface. There is one implementation now.
export { toPositiveInt };

/**
 * The two ids a rematch can carry. They live in **different id spaces** and
 * neither may ever substitute for the other — see `animeIds.ts`, whose brands
 * make the substitution a compile error rather than a convention:
 *
 *   dandanAnimeId — dandanplay's per-season anime id. Lands on `Season.animeId`
 *                   and drives danmaku + episode listings.
 *   anilistId     — AniList's id. Lands on `Series.anilistId` and drives
 *                   subscriptions and watch-progress sync.
 *
 * `/api/dandanplay/search` returns two **disjoint** row shapes: `animeCache`
 * rows carry `anilistId` and never `dandanAnimeId`; `dandanplay` rows carry
 * `dandanAnimeId` and never `anilistId`. The picker offers both sections, so
 * both fields are optional — but a hit with neither is not a usable pick.
 */
export interface RematchPayload {
  dandanAnimeId?: DandanAnimeId;
  anilistId?: AnilistId;
  titleZh?: string;
  titleEn?: string;
  posterUrl?: string;
  /**
   * The picked hit's episode count, when it had one. Both halves of the picker
   * carry it — `animeCache` rows as a nullable int, `dandanplay` rows as a
   * plain int — so unlike the two ids this field is NOT tied to which section
   * the user picked from.
   */
  totalEpisodes?: number;
  type: "tv" | "movie" | "ova" | "web";
}

/**
 * Normalize a raw search hit into the rematch payload.
 *
 * This used to read `Number(it.dandanAnimeId ?? it.anilistId ?? NaN)` and hand
 * the result over as a single `animeId`. Because animeCache rows never carry
 * `dandanAnimeId`, **every** pick from the cache section fell through to
 * `anilistId` — and an AniList id was then written into `Season.animeId` and
 * `userOverride.overrideSeasonAnimeId`, both of which are dandanplay id space.
 *
 * The import pipeline looks up seasons by dandanplay id, so a poisoned row can
 * never match again: a duplicate card on the next import, plus danmaku pointed
 * at whatever dandanplay anime happens to share that number.
 *
 * Each id now travels in its own field, narrowed by the normalizer for its own
 * space. A hit carrying only one of them is valid and the other stays
 * `undefined`; downstream skips the write it cannot make rather than
 * substituting. Reintroducing a `??` between the two lines below is a type
 * error — the fields are branded and the brands do not unify.
 */
export function normalizeRematchHit(item: unknown): RematchPayload | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const dandanAnimeId = toDandanAnimeId(it.dandanAnimeId);
  const anilistId = toAnilistId(it.anilistId);
  if (dandanAnimeId === undefined && anilistId === undefined) return null;
  let type: RematchPayload["type"] = "tv";
  if (typeof it.format === "string") {
    const f = it.format.toLowerCase();
    if (f.includes("movie")) type = "movie";
    else if (f.includes("ova")) type = "ova";
    else if (f.includes("web")) type = "web";
  }
  return {
    dandanAnimeId,
    anilistId,
    titleZh: (it.titleChinese as string) || undefined,
    titleEn: (it.title as string) || undefined,
    posterUrl:
      (it.coverImageUrl as string) || (it.imageUrl as string) || undefined,
    // Reuses toPositiveInt, so a null (uncached) or a 0 (unknown length) both
    // become `undefined` rather than a stored zero that reads as an answer.
    totalEpisodes: toPositiveInt(it.episodes),
    type,
  };
}
