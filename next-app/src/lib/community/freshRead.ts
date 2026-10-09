// A signed-in reader's pages read their state again after load (the server
// render is the anonymous, cached one). That read can still be in flight when
// the reader acts — likes, votes, replies — and its answer may predate the
// act. Painted over the act's own answer, it undoes it on screen: the like
// shows as not liked, the reply vanishes and gets posted twice.
//
// So the component counts the writes it applies, and a read during which the
// count moved is thrown away and sent again.

/** Bumped by the component each time it applies a write's answer. */
export interface WriteCounter {
  current: number;
}

export const FRESH_READ_ATTEMPTS = 3;

/**
 * Runs `read` until one completes with no write applied while it was in
 * flight, and returns that answer — or null when every attempt was
 * overtaken, in which case the state the writes left is kept.
 */
export async function freshRead<T>(
  writes: WriteCounter,
  read: () => Promise<T>,
  attempts: number = FRESH_READ_ATTEMPTS,
): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const writesBefore = writes.current;
    const answer = await read();
    if (writes.current === writesBefore) return answer;
  }
  return null;
}
