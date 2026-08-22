// Normalizing a search hit into a rematch payload — extracted from
// RematchDialog so the rule can be tested without mounting React.
//
// This module exists because of a bug that was firing on every pick from the
// richer half of the picker, so the extraction is not cosmetic: the rule below
// is the one thing standing between the user and a poisoned local library.

/**
 * The two ids a rematch can carry. They live in **different id spaces** and
 * neither may ever substitute for the other:
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
  dandanAnimeId?: number;
  anilistId?: number;
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

/** Positive integer or nothing. Search JSON is untrusted input. */
export function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
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
 * Each id now travels in its own field. A hit carrying only one of them is
 * valid and the other stays `undefined`; downstream skips the write it cannot
 * make rather than substituting.
 */
export function normalizeRematchHit(item: unknown): RematchPayload | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const dandanAnimeId = toPositiveInt(it.dandanAnimeId);
  const anilistId = toPositiveInt(it.anilistId);
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
