// Pure logic behind EpisodesGrid.tsx's watched set, split out so bun:test can
// reach it without rendering the client component — same split as
// episodeGridSkeleton.ts and episodeDiscussionState.ts next door.
//
// What this replaces, and why it earned a module of its own: the grid used to
// DERIVE which episodes were watched from a single `currentEpisode` counter —
//
//   watched = completed
//          || (current > 0 && n < current)
//          || (current > 0 && current >= total && n <= current)
//
// — so a reader who had watched only episode 5 was shown a green checkmark on
// 1, 2, 3 and 4 as well. A progress BAR is allowed to approximate; a per-cell
// checkmark is a claim about that specific episode and nothing else, and three
// of those four claims were invented by the frontend. The set is stored now, so
// the rule is a lookup and the inference is gone. It lives here rather than in
// the component so a test can say "5 watched must not mark 1-4" without a DOM.
//
// The second half of the file is the write tracker. The grid is a control now,
// clicks can overlap, and every write answers with the WHOLE new set — which
// means a slow response carrying an older set can arrive after a newer one and
// undo it. `settled` is the guard: a server answer is only allowed to become
// the new baseline if no later write has already been folded in.

/**
 * What one cell is entitled to claim.
 *
 * `completed` is separate from `watched` on purpose. Both draw a checkmark, but
 * they rest on different statements: `watched` means this episode is in the
 * stored set, `completed` means the reader marked the whole show finished and
 * every cell inherits that. Only the first is per-episode, so only the first is
 * something a single click can take back — the grid needs to be able to tell
 * them apart to know whether its toggle means anything.
 */
export type EpisodeCellState = "watched" | "completed" | "unwatched";

/** One in-flight click: which way it went, and which write owns the cell. */
export interface PendingToggle {
  readonly token: number;
  readonly watched: boolean;
}

/**
 * The confirmed set, the clicks that have not landed yet, and how far the
 * confirmations have got.
 *
 * `confirmed` is the last set a server response actually stated. `pending` is
 * laid over it to paint optimistically. `settled` is the highest token whose
 * response has been folded into `confirmed`; see settleWrite for what it stops.
 */
export interface WatchedTracker {
  readonly confirmed: ReadonlySet<number>;
  readonly pending: ReadonlyMap<number, PendingToggle>;
  readonly settled: number;
}

/** The subscription fields this module reads out of an API response. */
export interface WatchedSnapshot {
  /**
   * Whether the response actually STATED a set.
   *
   * The difference between "the server says you have watched nothing" and "the
   * server did not say" is the difference between a correct repaint and wiping
   * a reader's progress off the screen. A 204, a truncated body, or an endpoint
   * that predates the field all parse to an empty array; adopting that as the
   * new baseline would delete every other episode they had marked.
   */
  readonly stated: boolean;
  readonly watchedEpisodes: number[];
  readonly currentEpisode: number;
}

export const EMPTY_WATCHED_TRACKER: WatchedTracker = Object.freeze({
  confirmed: new Set<number>(),
  pending: new Map<number, PendingToggle>(),
  settled: 0,
});

/**
 * An episode number this set is allowed to contain.
 *
 * Non-integers are REJECTED rather than floored, which is the opposite of
 * episodeGridSkeleton's rule and deliberately so. There, flooring a `.5`
 * special answers "how many cells do we draw" — a `12.5` still lives inside
 * episode 12's row. Here the number IS the claim: folding `5.5` into `5` would
 * mark episode 5 watched on the strength of having watched a special, which is
 * the same kind of invention this module exists to delete.
 */
function usableEpisode(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= 1 ? value : null;
}

/** Drop the `{ data: … }` envelope when there is one. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in (value as object)) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function toEpisodeSet(episodes: Iterable<number>): ReadonlySet<number> {
  const out = new Set<number>();
  for (const value of episodes ?? []) {
    const episode = usableEpisode(value);
    if (episode !== null) out.add(episode);
  }
  return out;
}

/**
 * The watched set carried by a subscription read or an episode write.
 *
 * Accepts the `{ data: … }` envelope, the bare object, or the bare array, and
 * throws away anything that is not a usable episode number. Deliberately does
 * NOT fall back to `currentEpisode` when the array is absent: a server that has
 * not been taught to store the set has no per-episode record to report, and
 * reconstructing one from a counter is exactly the bug.
 */
export function parseWatchedEpisodes(value: unknown): number[] {
  const source = unwrap(value);
  const raw = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? (source as Record<string, unknown>).watchedEpisodes
      : null;
  if (!Array.isArray(raw)) return [];
  return [...toEpisodeSet(raw as number[])].sort((a, b) => a - b);
}

/**
 * Both fields the grid needs off one response.
 *
 * `currentEpisode` is derived server-side as the maximum of the set, so the
 * stated value wins when it is present and sane; the local maximum is only the
 * fallback for a response that omits it. The grid does not render this number
 * itself — it re-broadcasts it, so the cards on the home page and the profile
 * list stop showing a progress figure the detail page has already moved past.
 */
export function parseWatchedSnapshot(value: unknown): WatchedSnapshot {
  const watchedEpisodes = parseWatchedEpisodes(value);
  const source = unwrap(value);
  const stated =
    Array.isArray(source) ||
    (!!source &&
      typeof source === "object" &&
      Array.isArray((source as Record<string, unknown>).watchedEpisodes));
  const position =
    source && typeof source === "object"
      ? (source as Record<string, unknown>).currentEpisode
      : undefined;
  const derived = watchedEpisodes.length
    ? watchedEpisodes[watchedEpisodes.length - 1]
    : 0;
  return {
    stated,
    watchedEpisodes,
    currentEpisode:
      typeof position === "number" &&
      Number.isSafeInteger(position) &&
      position >= 0
        ? position
        : derived,
  };
}

/**
 * What a single cell is, given the set, the completed flag and its number.
 *
 * The whole point of the rewrite is in the else branch: membership, and nothing
 * about the neighbours. Nothing here looks at how far the reader has got.
 */
export function episodeCellState(
  watched: ReadonlySet<number>,
  completed: boolean,
  episode: number,
): EpisodeCellState {
  if (completed) return "completed";
  return watched && watched.has(episode) ? "watched" : "unwatched";
}

/** Convenience for the checkmark, which does not care which claim backs it. */
export function isWatchedCell(
  watched: ReadonlySet<number>,
  completed: boolean,
  episode: number,
): boolean {
  return episodeCellState(watched, completed, episode) !== "unwatched";
}

/**
 * How many of the drawn cells count as watched — the "N / total" readout that
 * replaces the ± stepper's number.
 *
 * Members outside 1..total are ignored rather than counted. The set can legally
 * hold an episode this grid does not draw (a catalogue count that shrank, an
 * automated write from a file numbered past the season), and counting those
 * would produce readouts like "14 / 12".
 */
export function watchedInGrid(
  watched: ReadonlySet<number>,
  completed: boolean,
  total: number,
): number {
  if (!Number.isSafeInteger(total) || total <= 0) return 0;
  if (completed) return total;
  let count = 0;
  for (const episode of watched ?? []) {
    if (episode >= 1 && episode <= total) count += 1;
  }
  return count;
}

/**
 * The highest episode the reader has actually MARKED, bounded by the grid.
 *
 * `max` over the set is not an inference. It is arithmetic over data we hold,
 * and it states a fact about the set rather than a claim about episodes we have
 * no record of — which is the distinction this whole module turns on. Saying
 * "5 is the furthest mark" is a different kind of sentence from saying "1-4 were
 * watched because 5 was", and only the second one was ever a lie.
 *
 * `completed` is deliberately NOT an input. A reader who set the status from
 * the dropdown without touching a single cell has marked nothing, and answering
 * `total` for them would put a "furthest marked" annotation on an episode that
 * carries no mark at all. Whether the grid PAINTS every cell as watched is a
 * separate question, answered by episodeCellState.
 */
export function furthestMarked(
  watched: ReadonlySet<number>,
  total: number,
): number | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  let best = 0;
  for (const episode of watched ?? []) {
    if (episode >= 1 && episode <= total && episode > best) best = episode;
  }
  return best > 0 ? best : null;
}

/** Does this cell carry the furthest-marked annotation? */
export function isFurthestMarked(
  watched: ReadonlySet<number>,
  total: number,
  episode: number,
): boolean {
  return furthestMarked(watched, total) === episode;
}

/**
 * Which episode's comment preview to show under a grid nobody has clicked.
 *
 * A reading position rather than a mark, which is why this one DOES fold in
 * `completed`: a reader who finished the show is at the end of it, and the
 * discussion worth previewing is the last episode's. Never rendered as a claim
 * about a cell — isFurthestMarked is what the grid annotates from.
 */
export function latestWatched(
  watched: ReadonlySet<number>,
  completed: boolean,
  total: number,
): number | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  if (completed) return total;
  return furthestMarked(watched, total);
}

/** Is every cell this grid draws in the set? False when there are no cells. */
export function coversEveryEpisode(
  watched: ReadonlySet<number>,
  total: number,
): boolean {
  if (!Number.isSafeInteger(total) || total <= 0) return false;
  if (!watched) return false;
  for (let episode = 1; episode <= total; episode += 1) {
    if (!watched.has(episode)) return false;
  }
  return true;
}

/** The status a toggle should drag the subscription to, if any. */
export type AutoStatus = "completed" | "watching";

/**
 * Should marking (or un-marking) an episode move the subscription's status?
 *
 * This is the stepper's auto-completion, re-expressed over the set: finishing
 * the last episode and having the show move itself to "completed" is the payoff
 * for marking episodes at all, and making the reader then hunt for a dropdown
 * turns a finished action into a chore.
 *
 * The two directions are NOT symmetric, and the asymmetry is the point:
 *
 *   INTO completed needs a CONFIRMED total. `confirmedTotal` is
 *      episodeGridSkeleton's `authoritative` count and 0 for anything else —
 *      an `inferred` total is a lower bound (a possibly-stale external count,
 *      or however many episode titles we happen to hold), and a reader who
 *      marks all eight cells of a show that actually runs twelve must not have
 *      their status rewritten on the strength of our guess. The detail page
 *      already refuses to print an inferred count as a total; silently
 *      restating one as "you finished this" is the same claim with teeth.
 *
 *   OUT OF completed needs no total at all. The reader has just said, about one
 *      specific episode, that they did not watch it — that contradicts
 *      "completed" no matter how many episodes there turn out to be, and it is
 *      their own statement rather than an inference off a count. It also has to
 *      work without a confirmed total for a plainer reason: `completed` paints
 *      every cell watched, so a grid that could not leave `completed` would be
 *      a grid whose toggles do nothing.
 *
 * Callers must only run this in response to a click. A reader opening a page
 * must never have their status rewritten by a render.
 */
export function autoStatusForSet(
  status: string | null | undefined,
  watched: ReadonlySet<number>,
  confirmedTotal: number,
): AutoStatus | null {
  const covered = coversEveryEpisode(watched, confirmedTotal);
  if (status === "completed") return covered ? null : "watching";
  return covered ? "completed" : null;
}

/** The confirmed set with every unlanded click laid over it. */
export function visibleWatched(tracker: WatchedTracker): ReadonlySet<number> {
  if (tracker.pending.size === 0) return tracker.confirmed;
  const out = new Set(tracker.confirmed);
  for (const [episode, toggle] of tracker.pending) {
    if (toggle.watched) out.add(episode);
    else out.delete(episode);
  }
  return out;
}

/**
 * Flip a cell now, and record which write owns it.
 *
 * The intent is the negation of what the cell currently SHOWS, which is why
 * both the visible set and `completed` go in. Two reasons, and the second is
 * the one that would otherwise ship a dead control:
 *
 *   - visible, not confirmed: a second click on a cell whose first click is
 *     still in flight reverses what the reader can see rather than what the
 *     server last said.
 *   - completed, not just the set: a reader who marked the show finished from
 *     the dropdown has an EMPTY set behind a grid of green checkmarks. Reading
 *     the intent off the set alone would answer "mark it watched" for a cell
 *     that already looks watched — a click on a checkmark that leaves the
 *     checkmark exactly where it was.
 *
 * `token` is supplied by the caller and must be strictly increasing across the
 * component's whole lifetime — it is the only ordering signal the rest of this
 * module has.
 */
export function beginToggle(
  tracker: WatchedTracker,
  episode: number,
  token: number,
  completed: boolean,
): { tracker: WatchedTracker; watched: boolean } {
  const shown =
    episodeCellState(visibleWatched(tracker), completed, episode) !== "unwatched";
  const watched = !shown;
  const pending = new Map(tracker.pending);
  pending.set(episode, { token, watched });
  return { tracker: { ...tracker, pending }, watched };
}

/**
 * Fold a server answer into the tracker.
 *
 * Two independent decisions, and separating them is the whole trick:
 *
 *   the SET is adopted only when `token > settled`. Every write answers with
 *   the complete new set, so two overlapping writes produce two complete sets
 *   and the older one is not a smaller edit — it is a whole earlier world. Let
 *   it land last and it silently deletes the newer episode. This is the
 *   out-of-order case, and it needs no timers: a response whose write started
 *   before one that has already been confirmed cannot know more than it.
 *
 *   the PENDING entry is cleared only when this write still owns the cell. A
 *   response for a click the reader has already reversed must not drop the
 *   reversal's optimistic paint, or the cell flickers back for as long as the
 *   second request takes.
 *
 * Adopting an older baseline is safe because `pending` is layered back on top:
 * writes still in flight keep showing their own intent either way.
 *
 * `episode` is null for a plain read (the mount probe), which owns no cell.
 */
export function settleWrite(
  tracker: WatchedTracker,
  token: number,
  episode: number | null,
  episodes: Iterable<number>,
): WatchedTracker {
  let confirmed = tracker.confirmed;
  let settled = tracker.settled;
  if (token > tracker.settled) {
    confirmed = toEpisodeSet(episodes);
    settled = token;
  }

  let pending: ReadonlyMap<number, PendingToggle> = tracker.pending;
  if (episode !== null) {
    const owner = tracker.pending.get(episode);
    if (owner && owner.token === token) {
      const cleared = new Map(tracker.pending);
      cleared.delete(episode);
      pending = cleared;
    }
  }

  if (confirmed === tracker.confirmed && pending === tracker.pending) {
    return tracker;
  }
  return { confirmed, pending, settled };
}

/**
 * Accept a write that succeeded without stating the new set.
 *
 * The narrow case settleWrite must not be used for: a 204, an empty body, or a
 * deploy where the endpoint answers before it learned to echo the set. The
 * write DID land, so this cell's intent is now true — but it is the only thing
 * this response licenses us to change. Handing settleWrite the empty array it
 * parsed to would adopt "nothing is watched" as the baseline and erase every
 * other episode the reader had marked.
 *
 * `settled` deliberately does not move: no set was stated, so nothing here can
 * outrank a real answer that is still on its way.
 */
export function confirmToggle(
  tracker: WatchedTracker,
  token: number,
  episode: number,
  watched: boolean,
): WatchedTracker {
  const confirmed = new Set(tracker.confirmed);
  if (watched) confirmed.add(episode);
  else confirmed.delete(episode);

  let pending: ReadonlyMap<number, PendingToggle> = tracker.pending;
  const owner = tracker.pending.get(episode);
  if (owner && owner.token === token) {
    const cleared = new Map(tracker.pending);
    cleared.delete(episode);
    pending = cleared;
  }
  return { ...tracker, confirmed, pending };
}

/**
 * Drop a write that never landed, and say whether the reader saw it go.
 *
 * `rolledBack` is false when a newer click already took the cell over. That
 * case needs no apology: the reader's current intent is still being pursued, so
 * the failed write has nothing left to contradict and a toast about it would
 * describe a state that is no longer on screen.
 *
 * When it IS true the caller owes the reader a visible failure. A rollback the
 * reader does not notice is worse than the bug this whole change fixes: they
 * believe they recorded an episode, the checkmark is gone by the time they look
 * again, and nothing ever said so.
 */
export function failWrite(
  tracker: WatchedTracker,
  token: number,
  episode: number,
): { tracker: WatchedTracker; rolledBack: boolean } {
  const owner = tracker.pending.get(episode);
  if (!owner || owner.token !== token) return { tracker, rolledBack: false };
  const pending = new Map(tracker.pending);
  pending.delete(episode);
  return { tracker: { ...tracker, pending }, rolledBack: true };
}
