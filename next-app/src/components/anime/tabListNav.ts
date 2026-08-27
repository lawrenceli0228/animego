// Arrow-key movement across a tablist, as arithmetic.
//
// Split out for the reason every other pure helper next door is split out
// (episodeGridSkeleton, continueWatchingState, torrentModalLogic): this repo
// has no DOM testing library, so behaviour that lives inside a component's
// event handler cannot be asserted. Index arithmetic in a module can.
//
// The parts worth testing are the ones that are easy to get subtly wrong and
// impossible to notice: wrapping backwards off index 0 without going
// negative, and returning null for keys this should not handle at all — a
// handler that preventDefaults everything traps Tab inside the tablist,
// which is a worse bug than the missing arrow keys it was added to fix.

/** Keys the tablist pattern reserves. Everything else must fall through. */
const HANDLED = ["ArrowRight", "ArrowLeft", "Home", "End"] as const;

export type TabListKey = (typeof HANDLED)[number];

export function isTabListKey(key: string): key is TabListKey {
  return (HANDLED as readonly string[]).includes(key);
}

/**
 * Where focus goes for `key`, or null if this key is not ours.
 *
 * Null is the important return. The caller uses it to decide whether to
 * preventDefault, and a caller that always does would swallow Tab (trapping
 * keyboard users inside the tablist) and typing (breaking find-as-you-type).
 *
 * Arrows wrap in both directions: at the last tab, Right returns to the
 * first. That is what the pattern specifies and what a horizontal strip of
 * seven weekdays should do — the list is a cycle.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0 || !isTabListKey(key)) return null;

  // A current index outside the list would otherwise produce a nonsense
  // target for the arrow cases. Treat it as "before the start".
  const from = current >= 0 && current < count ? current : 0;

  switch (key) {
    case "ArrowRight":
      return (from + 1) % count;
    case "ArrowLeft":
      // `+ count` before the modulo: JS `%` keeps the sign of the dividend,
      // so (0 - 1) % 7 is -1, not 6.
      return (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}
