import { describe, expect, test } from "bun:test";
import { GENRE_FETCH, GENRE_REVALIDATE } from "./fetch";

describe("the genre page's requests", () => {
  // Anonymous, or Next's data cache — keyed on the request's headers as well
  // as its URL — keeps one entry per reader's cookie: nothing shared between
  // readers, and the ISR pages crowded out of the in-memory cache.
  test("are shared for the page's window, and carry no reader", () => {
    expect(GENRE_FETCH).toEqual({ revalidate: GENRE_REVALIDATE, auth: false });
  });
});
