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
 * anime-relations' shifts for a series, or `undefined` when none were
 * fetched. `[]` is a known answer — the curated file has no rule — and is
 * kept apart from undefined for the same reason as 0 is from undefined above:
 * the backfill sweep re-asks only for undefined.
 *
 * Non-integers and zero are dropped (a zero shift moves nothing); order is
 * kept, since the first shift that fits wins.
 */
export function readRuleOffsets(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const v of value) {
    if (typeof v === "number" && Number.isInteger(v) && v !== 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Does a curated rule shift describe these files?
 *
 * Stricter than `offsetApplies` in one way: some number must lie OUTSIDE the
 * season. A rule shift is small — 12 for a second cour — so a set already
 * inside 1..total fits it too, and there the stored numbers are the safe
 * reading: a lone "13" on a 13-episode cour may be its own finale.
 */
function ruleShiftApplies(numbers: readonly number[], total: number, shift: number): boolean {
  if (!numbers.some((n) => n < 1 || n > total)) return false;
  return numbers.every((n) => {
    const site = n - shift;
    return site >= 1 && site <= total;
  });
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
 * Local episode number → the number the site uses, for every distinct number
 * given. A number the offset does not apply to maps to itself, so a caller
 * never has to tell "unchanged" from "unknown".
 *
 * WHOLE SET FIRST. When the offset maps every number into the season, all of
 * them move: that is a continuously numbered run, and validating it as a set
 * is what keeps a lone ambiguous number from deciding for the rest.
 *
 * THEN, ONLY WHAT CANNOT BE THE SEASON'S OWN. A card can hold both spaces at
 * once — a season begun from an "S02E01" release (stored 1) and then fed a
 * group's "- 16". The set fails, but 16 is past the season's end, so it is not
 * the season's own number, and 16 - offset lands inside the season. That one
 * moves. A number already inside the season stays where it is, because there
 * it could be either and the stored number is the safe reading. A move that
 * would land on a number the set already holds is not made either: two
 * seasons on one card look exactly like this, and which file is episode 1 is
 * not knowable here.
 *
 * RULE SHIFTS FIRST. `ruleOffsets` are anime-relations' curated shifts for
 * the series (see `readRuleOffsets`). The walked offset sums every earlier
 * season, which is the numbering of some release groups and not of others:
 * San no Shou Part 2 ships as 13–25 (shift 12) while the walk says 60. The
 * first rule shift that moves every number into the season, when some number
 * lies outside it, is used for the whole set; otherwise the walked offset
 * decides as before.
 *
 * Both the grid and the watch push call this with the numbers they hold, so
 * the rule is stated once and the two cannot drift apart.
 */
export function toSiteNumbers(
  numbers: readonly number[],
  total: number | undefined,
  offset: number | undefined,
  ruleOffsets?: readonly number[],
): Map<number, number> {
  const distinct = [...new Set(numbers)];
  const out = new Map(distinct.map((n) => [n, n] as const));
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return out;
  if (distinct.length > 0) {
    for (const shift of ruleOffsets ?? []) {
      if (!ruleShiftApplies(distinct, total, shift)) continue;
      for (const n of distinct) out.set(n, n - shift);
      return out;
    }
  }
  if (offset === undefined || offset <= 0) return out;

  if (offsetApplies(distinct, total, offset)) {
    for (const n of distinct) out.set(n, n - offset);
    return out;
  }

  const held = new Set(distinct);
  for (const n of distinct) {
    const site = n - offset;
    if (n > total && site >= 1 && site <= total && !held.has(site)) out.set(n, site);
  }
  return out;
}
