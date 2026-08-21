// Pure derivations for the /admin "繁体中文漂移" block.
//
// The defect this block exists to surface:
//
//   anime_cache.description_hant is an OpenCC conversion of description_cn,
//   and title_hant's bottom tier converts title_chinese. The river enrichment
//   workers keep filling the SIMPLIFIED columns; the Traditional ones only
//   move when the backfill job runs. So they fall behind and never self-heal.
//
// And it is invisible from the outside. The render ladder falls back rather
// than blanking, so a row that has lost its Traditional synopsis does not show
// an empty page — it shows the SIMPLIFIED synopsis, under a Traditional URL,
// to a reader who asked for Traditional. "descBehind: 2" therefore does not
// mean "2 rows are missing text". It means "2 rows are lying".
//
// Wire source (go-api internal/admin):
//   GET /api/admin/hant/stats -> { total, titleHant, descHant, serpEligible,
//                                  titleBehind, descBehind, lastRunAt,
//                                  running }
//
// Everything derived from those eight fields lives here rather than inline in
// JSX, so the arithmetic can be tested without a DOM stack — same split as
// backfillStatus.ts, whose coveragePct / formatCoveragePct / relativeAge this
// module deliberately reuses instead of growing a second copy.

/**
 * The six counters. `lastRunAt` and `running` are excluded on purpose: nothing
 * in this module does arithmetic on them, and a narrower parameter type keeps
 * the unit tests from having to invent a timestamp to ask what 0 + 0 is.
 */
export interface HantDriftCounts {
  /** Rows in anime_cache — the coverage denominator for BOTH columns. */
  total: number;
  /** Rows carrying a Traditional title, from any tier including conversion. */
  titleHant: number;
  /** Rows carrying a Traditional synopsis. */
  descHant: number;
  /**
   * Rows whose Traditional title came from a HUMAN source and may therefore
   * appear in <title> / JSON-LD. A generated column in the database excludes
   * the machine-converted ones, so this is always <= titleHant and the gap is
   * meaningful rather than an error — see {@link machineConvertedTitles}.
   */
  serpEligible: number;
  /** title_chinese IS NOT NULL AND title_hant IS NULL. */
  titleBehind: number;
  /** description_cn IS NOT NULL AND description_hant IS NULL. */
  descBehind: number;
}

/**
 * Coerces a wire number to a usable non-negative value.
 *
 * Same guard as backfillStatus.safeCount, and deliberately not imported from
 * there: that module keeps it private, and exporting it would make a
 * four-line defensive detail part of two modules' public API for no gain.
 */
function safeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * How many rows are currently serving Simplified text under a Traditional URL.
 *
 * The two counters are summed only for the "is there anything to do at all"
 * verdict — they count overlapping sets (one row can be behind on both its
 * title and its synopsis), so this total is an upper bound on ROWS and must
 * never be rendered as one. The UI shows the two numbers separately and uses
 * this purely to decide between the drift state and the all-clear.
 */
export function totalBehind(
  c: Pick<HantDriftCounts, "titleBehind" | "descBehind">,
): number {
  return safeCount(c.titleBehind) + safeCount(c.descBehind);
}

/** True when at least one column is behind — i.e. the block should alarm. */
export function hasDrift(
  c: Pick<HantDriftCounts, "titleBehind" | "descBehind">,
): boolean {
  return totalBehind(c) > 0;
}

/**
 * Traditional titles that exist but came out of OpenCC rather than a human.
 *
 * Rendered next to `serpEligible` because the gap between the two is the whole
 * point of the generated column: a machine-converted title is good enough to
 * show a reader and NOT good enough to put in a <title> tag or JSON-LD, where
 * it would become the site's claim about the work's name. Without this number
 * on screen, "6,422 SERP-eligible" out of "12,350 Traditional titles" reads
 * like 5,928 rows failed at something.
 *
 * Clamped at 0: serpEligible is a subset of titleHant, so a negative result
 * can only mean the two counts were taken at different moments, and a negative
 * count is nonsense to render.
 */
export function machineConvertedTitles(
  titleHant: number,
  serpEligible: number,
): number {
  return Math.max(safeCount(titleHant) - safeCount(serpEligible), 0);
}

/**
 * Poll cadence for the drift block, in ms. 0 means "stop polling".
 *
 * Only a RUNNING backfill earns a poller. Idle is this block's steady state —
 * the automatic floor is quarterly — so polling it would be a request every
 * few seconds for a number that moves four times a year. The counters cannot
 * change while the job is not running, either: the enrichment workers move the
 * Simplified columns, but `titleBehind` / `descBehind` are recomputed by the
 * same endpoint on the next page load anyway.
 *
 * 5s rather than the backfill block's 30s: this poller only exists while an
 * operator is watching a job they just started, and it stops on its own the
 * moment `running` goes false.
 */
export const HANT_POLL_MS = 5_000;

export function pickHantInterval(running: boolean): number {
  return running ? HANT_POLL_MS : 0;
}

/**
 * Whether the trigger button is disabled.
 *
 * Two independent reasons, and both are needed:
 *  - `running` — go-api says a backfill is in flight. Enqueuing a second one
 *    is at best wasted work over the same rows.
 *  - `pending` — this browser has a POST in flight whose response has not
 *    landed yet. `running` cannot cover this: it comes from the stats payload,
 *    which is at most as fresh as the last poll, so between the click and the
 *    refetch the button would otherwise stay live and double-submit.
 *
 * Deliberately NOT disabled when nothing is behind. A zero here is a claim the
 * operator may want to verify, and the whole reason this button exists is to
 * run the job sooner than the quarterly floor.
 */
export function isBackfillDisabled(running: boolean, pending: boolean): boolean {
  return running || pending;
}
