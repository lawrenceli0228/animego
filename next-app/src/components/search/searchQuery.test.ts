import { describe, expect, test } from "bun:test";
import {
  errorFromResponse,
  hasTerms,
  makeQuery,
  parseSearchResponse,
  queryFromParams,
  queryKey,
  sameQuery,
  sameTerms,
  searchApiPath,
  searchPath,
} from "./searchQuery";

describe("makeQuery", () => {
  test("trims the keyword", () => {
    expect(makeQuery("  frieren  ", "", 1).q).toBe("frieren");
  });

  test("a trailing space is not a new query", () => {
    // The reason trimming lives in makeQuery rather than at the call sites:
    // SearchExperience decides whether to fire a request by comparing the
    // typed query against the answered one. Space-terminated words are how
    // people type, and each one would otherwise cost a round trip that
    // returns rows already on screen.
    expect(sameQuery(makeQuery("frieren ", "", 1), makeQuery("frieren", "", 1))).toBe(
      true,
    );
  });

  test("page floors at 1 and drops fractions", () => {
    expect(makeQuery("x", "", 0).page).toBe(1);
    expect(makeQuery("x", "", -4).page).toBe(1);
    expect(makeQuery("x", "", Number.NaN).page).toBe(1);
    expect(makeQuery("x", "", 3.7).page).toBe(3);
  });

  test("sameTerms ignores the page, sameQuery does not", () => {
    // The debounce asks "have the controls moved away from what is on
    // screen?", and the controls cannot express a page. Asking that with
    // sameQuery made every page-2 view look like a pending change back to
    // page 1, so turning the page put the reader back a second later.
    const page1 = makeQuery("frieren", "", 1);
    const page2 = makeQuery("frieren", "", 2);
    expect(sameTerms(page1, page2)).toBe(true);
    expect(sameQuery(page1, page2)).toBe(false);
  });

  test("sameTerms still separates different searches", () => {
    // Anti-vacuity for the pair above: a sameTerms that returned true for
    // everything would satisfy it and stop the debounce firing at all.
    const base = makeQuery("frieren", "", 1);
    expect(sameTerms(base, makeQuery("bleach", "", 1))).toBe(false);
    expect(sameTerms(base, makeQuery("frieren", "Action", 1))).toBe(false);
  });

  test("distinct queries do not collide on the key", () => {
    const keys = [
      makeQuery("a", "Action", 1),
      makeQuery("a", "", 1),
      makeQuery("", "Action", 1),
      makeQuery("a", "Action", 2),
    ].map(queryKey);
    expect(new Set(keys).size).toBe(4);
  });
});

describe("queryFromParams", () => {
  test("absent params are the empty search", () => {
    const q = queryFromParams(undefined, undefined, undefined);
    expect(q).toEqual({ q: "", genre: "", page: 1 });
    expect(hasTerms(q)).toBe(false);
  });

  test("a junk page is page 1, not NaN", () => {
    // ?page=<anything> is reader-supplied. NaN here would reach searchApiPath
    // and go out as `page=NaN`.
    expect(queryFromParams("x", undefined, "banana").page).toBe(1);
    expect(queryFromParams("x", undefined, "3").page).toBe(3);
  });

  test("a genre alone is a real search", () => {
    expect(hasTerms(queryFromParams(undefined, "Action", undefined))).toBe(true);
  });

  test("whitespace alone is not", () => {
    // go-api answers 400 to a request carrying neither term. This is the guard
    // that stops the browser making one.
    expect(hasTerms(queryFromParams("   ", undefined, undefined))).toBe(false);
  });
});

describe("searchPath", () => {
  test("empty params are dropped rather than sent blank", () => {
    expect(searchPath(makeQuery("", "", 1))).toBe("/search");
    expect(searchPath(makeQuery("frieren", "", 1))).toBe("/search?q=frieren");
    expect(searchPath(makeQuery("", "Action", 1))).toBe("/search?genre=Action");
  });

  test("page 1 is left implicit, later pages are not", () => {
    expect(searchPath(makeQuery("frieren", "", 1))).toBe("/search?q=frieren");
    expect(searchPath(makeQuery("frieren", "", 2))).toBe("/search?q=frieren&page=2");
  });

  test("a keyword with URL punctuation survives the round trip", () => {
    // 100% and Re:Zero are both real titles, and both carry characters that a
    // hand-built query string would mangle.
    const path = searchPath(makeQuery("Re:Zero 100%", "", 1));
    const parsed = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(parsed.get("q")).toBe("Re:Zero 100%");
  });
});

describe("searchApiPath", () => {
  test("always sends an explicit page", () => {
    expect(searchApiPath(makeQuery("frieren", "", 1))).toBe(
      "/api/anime/search?q=frieren&page=1",
    );
  });

  test("is root-relative so nginx routes it to go-api", () => {
    // Not `${getApiBase()}/...` — this one is fetched by the browser, and in
    // production next-app serves no /api rewrite (next.config.ts returns []
    // under NODE_ENV=production); nginx makes that hop.
    expect(searchApiPath(makeQuery("x", "", 1)).startsWith("/api/")).toBe(true);
  });
});

describe("parseSearchResponse", () => {
  const envelope = {
    data: [{ anilistId: 1 }, { anilistId: 2 }],
    pagination: { page: 2, perPage: 20, total: 45, totalPages: 3 },
  };

  test("unwraps the go-api envelope", () => {
    expect(parseSearchResponse(envelope)).toEqual({
      rows: envelope.data,
      page: 2,
      perPage: 20,
      total: 45,
      totalPages: 3,
    } as never);
  });

  test("derives totalPages when the field is missing", () => {
    // A missing totalPages defaulting to 0 would hide the pagination controls
    // on a genuinely multi-page result — the one wrong answer a reader cannot
    // tell apart from "there is no more".
    const parsed = parseSearchResponse({
      data: [],
      pagination: { page: 1, perPage: 20, total: 45 },
    });
    expect(parsed?.totalPages).toBe(3);
  });

  test("an empty result set is a result set, not a failure", () => {
    const parsed = parseSearchResponse({
      data: [],
      pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.rows).toEqual([]);
  });

  test("returns null for shapes that are not a result set", () => {
    for (const body of [
      null,
      undefined,
      "text",
      42,
      {},
      { data: null },
      { data: "not an array" },
      { error: { code: "SERVER_ERROR", message: "boom" } },
    ]) {
      expect(parseSearchResponse(body)).toBeNull();
    }
  });

  test("survives a missing pagination block", () => {
    // Not a shape go-api emits, but the fallbacks exist so a truncated or
    // proxy-rewritten body degrades to "one page of what we got" instead of
    // throwing inside a render.
    const parsed = parseSearchResponse({ data: [{ anilistId: 7 }] });
    expect(parsed?.total).toBe(1);
    expect(parsed?.page).toBe(1);
  });
});

describe("errorFromResponse", () => {
  test("prefers go-api's message", () => {
    expect(
      errorFromResponse({ error: { code: "SERVER_ERROR", message: "AniList timeout" } }, 504),
    ).toBe("AniList timeout");
  });

  test("falls back to the status when there is no usable prose", () => {
    expect(errorFromResponse(null, 502)).toBe("HTTP 502");
    expect(errorFromResponse({ error: {} }, 503)).toBe("HTTP 503");
    expect(errorFromResponse({ error: { message: "" } }, 500)).toBe("HTTP 500");
  });
});
