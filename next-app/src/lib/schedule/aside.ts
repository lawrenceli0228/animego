// Which box the schedule page's aside shows between the week chart and the
// next-season link. Split out of ScheduleBoard so the decision can be tested
// without a DOM.
//
// Pure: no React, no DOM.

/** "mine": 我追的 · 本周. "signIn": the visitor prompt. null: neither. */
export type AsideBox = "mine" | "signIn" | null;

/**
 * A visitor gets the sign-in prompt whether or not the schedule loaded: it
 * says nothing about the week. A signed-in reader gets 我追的 · 本周 only when
 * there is a week to read it from. With the schedule missing, its empty state
 * would say "nothing you follow airs this week" right beside "the schedule did
 * not load" — the same false claim seven tabs of 0 would make — so the box is
 * left out instead.
 *
 * @param progress anilistId → watched-up-to episode; null for a visitor.
 * @param loaded whether the week arrived (the board's days are non-empty).
 */
export function asideBox(progress: Readonly<Record<number, number>> | null, loaded: boolean): AsideBox {
  if (!progress) return "signIn";
  return loaded ? "mine" : null;
}
