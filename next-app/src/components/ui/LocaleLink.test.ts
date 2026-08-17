import { describe, expect, test } from "bun:test";
import { localizeHref } from "./LocaleLink";

// Only the pure href transform is tested here. Rendering the component needs
// a router context, and the interesting behaviour — which hrefs get a prefix
// and which are left alone — is entirely in this function. The wiring is
// covered end to end by e2e/specs/sandbox/locale-routing.spec.ts.

describe("in the default locale", () => {
  test("nothing changes", () => {
    for (const href of ["/", "/search", "/anime/21", "/u/alice/followers"]) {
      expect(localizeHref(href, "zh-Hans")).toBe(href);
    }
  });
});

describe("in a prefixed locale", () => {
  test("root-relative paths take the prefix", () => {
    expect(localizeHref("/search", "en")).toBe("/en/search");
    expect(localizeHref("/anime/21", "en")).toBe("/en/anime/21");
  });

  test("the root path does not grow a trailing slash", () => {
    expect(localizeHref("/", "en")).toBe("/en");
  });

  test("the query and fragment ride along untouched", () => {
    expect(localizeHref("/search?q=frieren", "en")).toBe("/en/search?q=frieren");
    expect(localizeHref("/faq#billing", "en")).toBe("/en/faq#billing");
    expect(localizeHref("/search?q=a&b=c#d", "en")).toBe("/en/search?q=a&b=c#d");
  });

  test("an already-prefixed href is not prefixed twice", () => {
    // The language menu links across locales on purpose. Doubling the prefix
    // would send the reader to /en/en/faq, which resolves to nothing.
    expect(localizeHref("/en/faq", "en")).toBe("/en/faq");
    expect(localizeHref("/en", "en")).toBe("/en");
  });
});

describe("hrefs that are left alone", () => {
  test("absolute URLs and other schemes", () => {
    for (const href of [
      "https://github.com/lawrenceli0228/animego",
      "http://example.com/x",
      "mailto:animegoanime@animegoclub.com",
      "//cdn.example.com/x",
    ]) {
      expect(localizeHref(href, "en")).toBe(href);
    }
  });

  test("same-page fragments and bare queries", () => {
    expect(localizeHref("#top", "en")).toBe("#top");
    expect(localizeHref("?page=2", "en")).toBe("?page=2");
  });

  test("API paths, which are not pages", () => {
    // Prefixing one produces a 404 the caller cannot see coming, because it
    // would fail at fetch time rather than at navigation.
    expect(localizeHref("/api/auth/me", "en")).toBe("/api/auth/me");
  });

  test("relative hrefs", () => {
    expect(localizeHref("followers", "en")).toBe("followers");
    expect(localizeHref("./x", "en")).toBe("./x");
  });
});
