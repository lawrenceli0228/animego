// The one rule for translating between the two episode-number spaces.
//
// TWO SPACES, AND THE ONLY PLACE THE CONVERSION IS STATED
//
//   local  the number on disk. Release groups routinely number continuously
//          across seasons, so the finale of a 10-episode second season whose
//          predecessor ran 28 is called 38.
//   site   the number the season itself uses, 1..episodeCount. This is what
//          `subscriptions/validate.go` range-checks, and what a reader means
//          when they say "episode 10".
//
// They were never reconciled. The grid inferred a shift from the files alone
// ("the lowest one I hold must be episode 1"), which is right for a full
// season and wrong for a tail — a lone finale numbered 38 rendered in slot 1.
// The watch push did not translate at all, so it sent 38 into a range check
// that stops at 10 and got a 400 every time; that season's progress had never
// synced, silently, for as long as the file had been in the library.
//
// The fix needs the same decision in both places, and the two live in
// different layers — `_services/episodeGridModel` renders, `lib/watchSync`
// pushes. Two copies of a rule this quiet is how they drift: the display
// would show episode 10 while the push sent 38, and nothing would fail. So it
// is stated once, here, in `lib/` where both may import it.
//
// The offset itself comes from GET /api/anime/{id}/episode-offset, which
// walks PREQUEL edges. See `resolveSeriesBinding.fetchEpisodeOffset`.

/**
 * A measured offset, or `undefined` when none was measured.
 *
 * `0` and `undefined` are OPPOSITE instructions, never two flavours of empty:
 * 0 says "nothing precedes this season, stop inferring a shift", undefined
 * says "we do not know, carry on inferring one". Any `offset ?? 0` at a call
 * site collapses the second into the first and renumbers a library against an
 * origin nobody established.
 */
export function readEpisodeOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Does this offset actually describe these files?
 *
 * The server knows the franchise; only the caller knows what is on disk, and
 * `format` is a coarse proxy for "counts toward the continuous numbering". So
 * a measurement is checked against the evidence before it is trusted: every
 * episode must land inside the season it claims to belong to.
 *
 * Returns false for an unmeasured offset, an unknown total, or an empty set —
 * "cannot be applied" rather than "declined", because the caller's next move
 * is the same in all three cases.
 */
export function offsetApplies(
  numbers: readonly number[],
  total: number | undefined,
  offset: number | undefined,
): boolean {
  if (offset === undefined || offset <= 0) return false;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return false;
  if (numbers.length === 0) return false;
  return numbers.every((n) => {
    const site = n - offset;
    return site >= 1 && site <= total;
  });
}

/**
 * Local episode numbers → the numbers the site uses, or `null` when the
 * offset must not be applied.
 *
 * ALL OR NOTHING, and that is the load-bearing part. Translating the episodes
 * that happen to fit and leaving the rest alone would put two numbering
 * spaces inside one request — and worse, it would let the grid and the push
 * disagree about the same file, because the grid applies `offsetApplies` to
 * the whole card. `null` means "send what you already had", which is exactly
 * what the grid means by rendering the stored number.
 */
export function toSiteEpisodes(
  numbers: readonly number[],
  total: number | undefined,
  offset: number | undefined,
): number[] | null {
  if (!offsetApplies(numbers, total, offset)) return null;
  const shift = offset as number;
  return numbers.map((n) => n - shift);
}
