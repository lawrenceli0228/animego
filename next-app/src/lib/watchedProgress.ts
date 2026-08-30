/**
 * A one-way notification that the watched set for an anime has changed.
 *
 * Two components on the detail page read the same fact from the same
 * endpoint: EpisodesGrid owns the per-episode set and writes to it, and
 * SubscriptionButton shows the count beside the status control. They are
 * siblings with no shared state, so each fetched `/api/subscriptions/:id`
 * once on mount and then drifted — tick an episode in the grid and the
 * number next to the status select kept the value it loaded with.
 *
 * This is deliberately NOT a store. The set has exactly one owner
 * (EpisodesGrid) and one writer (the same), and the server remains the
 * source of truth; this only carries "the number you were shown is stale,
 * here is the current one" to a read-only display. Making it a store would
 * invite a second writer, which is the thing SubscriptionButton's header
 * comment says was removed on purpose — the old stepper set currentEpisode
 * by hand while the grid derived it from the set, and the two disagreed.
 *
 * Module-scope rather than a React context because the publisher and the
 * subscriber are in different subtrees, and threading a provider through
 * page.tsx would put a client boundary around a server component.
 */

export interface WatchedProgress {
  anilistId: number;
  /** Episodes in the watched set. Not "furthest episode". */
  watched: number;
}

type Listener = (progress: WatchedProgress) => void;

const listeners = new Set<Listener>();

/**
 * Last value published per anime, so a subscriber that mounts after a write
 * is not left showing its own stale fetch. Keyed by id because the detail
 * page for a different anime must not read this one's count — the map is
 * never cleared, but it holds one small object per anime visited in a
 * session, which is bounded by navigation rather than by time.
 */
const latest = new Map<number, WatchedProgress>();

/** Called by the owner of the set after every successful local change. */
export function publishWatchedProgress(progress: WatchedProgress): void {
  latest.set(progress.anilistId, progress);
  for (const fn of listeners) fn(progress);
}

/**
 * Subscribe to changes. Returns an unsubscribe function.
 *
 * The listener is NOT called with the current value on subscribe — read
 * `peekWatchedProgress` for that if you need it, so a caller that only
 * wants future changes does not have to filter out an immediate callback.
 */
export function subscribeWatchedProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The last published value for an anime, or null if none. */
export function peekWatchedProgress(anilistId: number): WatchedProgress | null {
  return latest.get(anilistId) ?? null;
}

/** Test seam. Not called by application code. */
export function resetWatchedProgress(): void {
  listeners.clear();
  latest.clear();
}
