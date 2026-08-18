import { describe, expect, test } from "bun:test";
import { authHrefWithFrom } from "./authFromLink";
import { sanitizeFromParam } from "@/lib/authForm";

// Next.js URL-decodes searchParams before the page sees them, so the
// round-trip assertions below decode once (via URL.searchParams) and then
// feed sanitizeFromParam exactly what /login and /register would receive.
function fromParamOf(href: string): string | undefined {
  const url = new URL(href, "https://animegoclub.com");
  return url.searchParams.get("from") ?? undefined;
}

describe("authHrefWithFrom", () => {
  test("carries a plain path as an encoded from param", () => {
    expect(authHrefWithFrom("/login", "/anime/123")).toBe(
      "/login?from=%2Fanime%2F123",
    );
    expect(authHrefWithFrom("/register", "/anime/123")).toBe(
      "/register?from=%2Fanime%2F123",
    );
  });

  test("encodes the query string instead of leaking it into the URL", () => {
    // The naive `?from=${path}` form would hand /login a second param
    // ("seriesId") and truncate `from` to "/player".
    const href = authHrefWithFrom("/login", "/player?seriesId=abc&fileId=42");
    expect(href).toBe("/login?from=%2Fplayer%3FseriesId%3Dabc%26fileId%3D42");
    expect(fromParamOf(href)).toBe("/player?seriesId=abc&fileId=42");
  });

  test("encodes a hash so it isn't dropped by the browser", () => {
    const href = authHrefWithFrom("/login", "/admin/users#pending");
    expect(href).toBe("/login?from=%2Fadmin%2Fusers%23pending");
    expect(fromParamOf(href)).toBe("/admin/users#pending");
  });

  test("omits the param for the root path", () => {
    // Both surfaces already default to "/", so ?from=%2F is pure noise.
    expect(authHrefWithFrom("/login", "/")).toBe("/login");
    expect(authHrefWithFrom("/register", "/")).toBe("/register");
  });

  test("omits the param when there is no path to carry", () => {
    // usePathname() is typed string | null; the auth forms can hold "".
    expect(authHrefWithFrom("/login", null)).toBe("/login");
    expect(authHrefWithFrom("/login", undefined)).toBe("/login");
    expect(authHrefWithFrom("/login", "")).toBe("/login");
  });

  test("refuses to build a self-loop", () => {
    expect(authHrefWithFrom("/login", "/login")).toBe("/login");
    expect(authHrefWithFrom("/login", "/register")).toBe("/login");
    expect(authHrefWithFrom("/register", "/register")).toBe("/register");
    expect(authHrefWithFrom("/register", "/login")).toBe("/register");
  });

  test("refuses a self-loop that hides behind a query or hash", () => {
    expect(authHrefWithFrom("/register", "/login?from=%2Flibrary")).toBe(
      "/register",
    );
    expect(authHrefWithFrom("/register", "/login#form")).toBe("/register");
  });

  test("keeps unrelated routes that merely share the prefix", () => {
    // "/loginfoo" is a different route, not the auth surface — the
    // boundary check must not swallow it.
    expect(authHrefWithFrom("/register", "/logins")).toBe(
      "/register?from=%2Flogins",
    );
  });

  test("rejects off-origin targets before they reach the URL", () => {
    // sanitizeFromParam would drop these anyway; failing here keeps a
    // dead ?from= out of the markup in the first place.
    expect(authHrefWithFrom("/login", "//evil.com/path")).toBe("/login");
    expect(authHrefWithFrom("/login", "https://evil.com")).toBe("/login");
    expect(authHrefWithFrom("/login", "javascript:alert(1)")).toBe("/login");
    expect(authHrefWithFrom("/login", "/\\evil.com")).toBe("/login");
    expect(authHrefWithFrom("/login", "/\tevil.com")).toBe("/login");
    expect(authHrefWithFrom("/login", "relative/path")).toBe("/login");
  });

  test("encodes non-ASCII paths", () => {
    // usePathname() returns the percent-encoded pathname in the browser,
    // but a server-held `from` (and the dev-server pathname) can be
    // decoded — both shapes have to survive.
    expect(authHrefWithFrom("/login", "/search?q=进击的巨人")).toBe(
      "/login?from=%2Fsearch%3Fq%3D%E8%BF%9B%E5%87%BB%E7%9A%84%E5%B7%A8%E4%BA%BA",
    );
    // Already-encoded input double-encodes on the wire, which is correct:
    // one decode happens in transit, leaving the encoded path the browser
    // can navigate to.
    const href = authHrefWithFrom("/login", "/search?q=%E5%B7%A8%E4%BA%BA");
    expect(fromParamOf(href)).toBe("/search?q=%E5%B7%A8%E4%BA%BA");
  });

  test("encodes characters that would otherwise break out of the param", () => {
    const href = authHrefWithFrom("/login", "/anime/123?t=a b&x=1#z");
    expect(href).not.toContain(" ");
    expect(href.split("?").length).toBe(2);
    expect(fromParamOf(href)).toBe("/anime/123?t=a b&x=1#z");
  });
});

// The generation side is only useful if the consumption side keeps what
// it is handed. These two allowlists are mirrored by hand (see the header
// comment in authFromLink.ts), so this suite is what catches them drifting
// apart — a drift is silent otherwise: the link renders with a ?from= and
// the user still lands on "/".
describe("round-trips through sanitizeFromParam", () => {
  const survives = [
    "/anime/123",
    "/library",
    "/settings",
    "/u/lawrence",
    "/player?seriesId=abc&fileId=42",
    "/admin/users#pending",
    "/search?q=进击的巨人",
  ];

  for (const path of survives) {
    test(`${path} survives the trip`, () => {
      const href = authHrefWithFrom("/login", path);
      expect(sanitizeFromParam(fromParamOf(href))).toBe(path);
    });
  }

  test("nothing that gets emitted is dropped on arrival", () => {
    // Everything sanitizeFromParam rejects must already have been dropped
    // here; the inverse (we drop something it would have accepted) is a
    // conservatism we accept, but a ?from= it silently discards is a bug.
    const hostile = [
      "//evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "/login",
      "/register?from=%2F",
      "/.well-known/x",
      "/_next/data",
      "/",
      "",
    ];
    for (const path of hostile) {
      expect(authHrefWithFrom("/login", path)).toBe("/login");
    }
  });
});

describe("locale awareness", () => {
  // `from` is always a real path the caller already holds, so it is also
  // the only thing that knows which locale tree the reader is in. Deriving
  // the surface from it means the eleven call sites cannot each get it
  // wrong, and the promise ("we will bring you back here") is kept in the
  // language it was made in.
  test("the surface follows the locale of `from`", () => {
    expect(authHrefWithFrom("/login", "/en/library")).toBe(
      "/en/login?from=%2Fen%2Flibrary",
    );
    expect(authHrefWithFrom("/register", "/en/anime/21")).toBe(
      "/en/register?from=%2Fen%2Fanime%2F21",
    );
  });

  test("the default locale keeps bare surfaces", () => {
    expect(authHrefWithFrom("/login", "/library")).toBe("/login?from=%2Flibrary");
  });

  test("the locale root IS a usable round-trip value", () => {
    // Bare "/" is rejected — both surfaces already default there, so
    // ?from=%2F would be pure noise. "/en" is not the same case: the
    // surfaces do NOT default there, so without carrying it an English
    // reader signs in and lands on the Chinese home page.
    expect(authHrefWithFrom("/login", "/en")).toBe("/en/login?from=%2Fen");
    expect(authHrefWithFrom("/login", "/")).toBe("/login");
  });

  test("a prefixed self-loop is still a self-loop", () => {
    // This is the one that would have shipped broken. The check compared
    // the raw value, so "/en/login" did not match "/login" and an English
    // reader clicking sign-in from the login page would have been sent
    // back to the form they had just cleared.
    expect(authHrefWithFrom("/login", "/en/login")).toBe("/en/login");
    expect(authHrefWithFrom("/register", "/en/register")).toBe("/en/register");
    expect(authHrefWithFrom("/login", "/en/login?from=%2Fen%2Ffaq")).toBe("/en/login");
  });

  test("a route that merely starts with the surface name is not a self-loop", () => {
    expect(authHrefWithFrom("/login", "/en/loginfoo")).toBe(
      "/en/login?from=%2Fen%2Floginfoo",
    );
  });
});
