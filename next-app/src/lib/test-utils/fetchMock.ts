import { mock, type Mock } from "bun:test";

/**
 * The call signature every fetch mock in this repo is actually invoked with.
 *
 * `bun:test`'s `mock()` infers the element type of `.mock.calls` from the
 * implementation you hand it, not from whatever you later assign it to. All
 * of these tests pass a zero-argument body — `mock(async () => new
 * Response(...))` — because none of them need the arguments to produce a
 * response. That makes `Parameters<T>` the empty tuple, so reading back the
 * `init` the code under test passed (`spy.mock.calls[0][1]`) does not
 * compile, even though the mock receives it perfectly well at runtime.
 *
 * Declaring the parameter type here fixes the inference without touching a
 * single mock body: a function with fewer declared parameters is assignable
 * to a wider signature, since JavaScript simply ignores the extra arguments.
 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` mock that is assignable to `globalThis.fetch` without a cast at
 * the call site, and still a fully typed `Mock` for reading `.mock.calls`.
 *
 * Bun augments the ambient `fetch` declaration with a static
 * `fetch.preconnect()` member (bun-types/globals.d.ts). A `Mock<T>` is a
 * plain callable object with `.mock` and `.mockClear()` and no reason to
 * carry that, so the two types do not overlap enough for TypeScript to
 * accept a direct `as typeof fetch` — it asks for the two-step cast through
 * `unknown` instead. That two-step cast is the right answer; having
 * twenty-one copies of it spread across four test files was not, and those
 * twenty-one copies were most of what kept `tsc --noEmit` red and therefore
 * unusable as a CI gate.
 */
export function mockFetch(impl: FetchImpl): Mock<FetchImpl> & typeof fetch {
  return mock(impl) as unknown as Mock<FetchImpl> & typeof fetch;
}
