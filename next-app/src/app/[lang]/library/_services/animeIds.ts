// The id spaces a library import touches, and the one rule that governs them.
//
// THE RULE
//
//   dandanplay's `animeId`, AniList's `id` and bgm.tv's subject id are DISJOINT
//   spaces. None may ever substitute for another, and a number that cannot be
//   proven to be in one space must be ABSENT, not guessed.
//
// WHY IT NEEDS A MODULE
//
// The repo has broken this rule twice, on the two paths that resolve a series,
// and fixed it twice without sharing a line of code:
//
//   · manual rematch — `normalizeRematchHit` read
//     `it.dandanAnimeId ?? it.anilistId ?? NaN` into a single `animeId` field.
//     `/api/dandanplay/search` returns two disjoint row shapes, so EVERY pick
//     from the animeCache section (the richer one, listed first) fell through
//     to the AniList id and wrote it into dandanplay id space.
//   · automatic import — `dandanClient.match` ended the same kind of chain in
//     `?? merged.bgmId`. `/match` emits no dandanplay animeId in any phase, so
//     that tail was not a fallback: it was the only term that ever fired, and
//     every matched import wrote a bgm.tv subject id into `Season.animeId`.
//
// Same bug, same shape, two independent fixes. Two fixes and no shared code is
// how a rule drifts back apart, so the rule lives here now and both paths
// import it.
//
// WHY IT CANNOT BE CAUGHT LATER
//
// The spaces collide numerically — 806 is a live id in all three and resolves
// to three unrelated shows — so there is no range check, no checksum and no
// repair pass that can tell a poisoned row from a good one. The only place the
// mix-up is still visible is where the number is read out of untrusted JSON,
// which is exactly and only here.
//
// HOW THE COMPILER HELPS
//
// Each space gets a brand. The brand is OPTIONAL (`__idSpace?`) on purpose:
//
//   · `AnilistId` → `DandanAnimeId` is an ERROR, because `"anilist"` is not
//     assignable to `"dandanplay"`. That is the substitution, and the compiler
//     message spells out the rule almost verbatim.
//   · a plain `number` still flows into either, which keeps the assertion style
//     the existing tests use (`expect(payload?.anilistId).toBe(21)`) compiling.
//     A required brand rejects the literal `21` and would have forced a rewrite
//     of the very tests that pin the fix.
//
// So the brand catches the substitution, not the sloppiness. The remaining hole
// is laundering — `Number(...)` or `toPositiveInt(...)` erases the brand — and
// that is closed behaviourally instead, by the wire-shape tests in
// `dandanClient.test.ts` and `rematchPayload.test.ts`, which feed the real
// envelopes in and assert the foreign id never appears in the field.

/**
 * dandanplay's per-season anime id.
 *
 * Lands on `Season.animeId`, which is what season reuse (`findReusableSeason`)
 * and danmaku/episode lookups key on. A poisoned value here can never match
 * again: the next import mints a duplicate card, and danmaku points at whatever
 * unrelated show happens to own that number.
 */
export type DandanAnimeId = number & { readonly __idSpace?: "dandanplay" };

/**
 * AniList's id.
 *
 * Lands on `Series.anilistId` — and only ever through `animeBinding.ts`, which
 * is the chokepoint that stops an automatic write from stomping a binding the
 * user set by hand. Drives subscriptions and watch-progress sync.
 */
export type AnilistId = number & { readonly __idSpace?: "anilist" };

/**
 * bgm.tv's subject id.
 *
 * Nothing in the library writes one. It is modelled anyway because it arrives
 * in the same `/match` envelope as the other two and was the actual value that
 * poisoned `Season.animeId` — keeping it typed is what turns a relapse into a
 * compile error instead of a silent, unrepairable write.
 */
export type BgmSubjectId = number & { readonly __idSpace?: "bgm" };

/**
 * The value a `Season.animeId` slot carries when no dandanplay id was proven.
 *
 * Zero rather than `undefined` because the import pipeline's guards are gated
 * on FALSINESS, not on validity: a falsy id re-enables the folder-home and
 * title-home heuristics (`importPipeline.js`), while a plausible-but-foreign id
 * disables them silently and then fails season reuse forever. Empty degrades.
 * Wrong does not degrade — it just reads as answered.
 */
export const NO_DANDAN_ANIME_ID = 0;

/**
 * Positive integer, or nothing.
 *
 * Every id below arrives as untrusted JSON, where `null`, `0`, `""` and
 * `"abc"` all mean "the server had nothing". They must all become `undefined`,
 * because a stored `0` reads downstream as an answer rather than as a gap.
 */
export function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Narrow untrusted input to a dandanplay animeId. The only way to mint one. */
export function toDandanAnimeId(value: unknown): DandanAnimeId | undefined {
  return toPositiveInt(value) as DandanAnimeId | undefined;
}

/** Narrow untrusted input to an AniList id. The only way to mint one. */
export function toAnilistId(value: unknown): AnilistId | undefined {
  return toPositiveInt(value) as AnilistId | undefined;
}

/** Narrow untrusted input to a bgm.tv subject id. The only way to mint one. */
export function toBgmSubjectId(value: unknown): BgmSubjectId | undefined {
  return toPositiveInt(value) as BgmSubjectId | undefined;
}
