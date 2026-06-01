import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hasAuthHint } from "./clientAuth";

// bun:test runs in node (no jsdom). hasAuthHint reads `document.cookie`, so we
// install a minimal document stub with a settable cookie string and restore
// the original after each test. This replaces the old server-side
// loggedInFromCookies coverage (cookie -> login signal), now done client-side
// off the non-httpOnly `auth_hint` cookie.

type DocLike = { cookie: string };
const hadDocument = "document" in globalThis;
const original = (globalThis as { document?: DocLike }).document;

function setCookie(value: string): void {
  (globalThis as { document?: DocLike }).document = { cookie: value };
}

describe("hasAuthHint", () => {
  beforeEach(() => {
    setCookie("");
  });

  afterEach(() => {
    if (hadDocument) {
      (globalThis as { document?: DocLike }).document = original;
    } else {
      delete (globalThis as { document?: DocLike }).document;
    }
  });

  test("true when auth_hint=1 is the only cookie", () => {
    setCookie("auth_hint=1");
    expect(hasAuthHint()).toBe(true);
  });

  test("true when auth_hint=1 sits among other cookies", () => {
    setCookie("lang=zh; auth_hint=1; theme=dark");
    expect(hasAuthHint()).toBe(true);
  });

  test("false when no auth_hint cookie is present (logged-out visitor)", () => {
    setCookie("lang=zh; theme=dark");
    expect(hasAuthHint()).toBe(false);
  });

  test("false when the cookie jar is empty", () => {
    setCookie("");
    expect(hasAuthHint()).toBe(false);
  });

  test("false for a cleared hint (auth_hint= with no value)", () => {
    // go-api clears the hint on logout by expiring it; a lingering empty
    // value must NOT count as logged in.
    setCookie("auth_hint=; lang=zh");
    expect(hasAuthHint()).toBe(false);
  });

  test("ignores a value that merely starts with 1 (auth_hint=10)", () => {
    // \b after the 1 guards against a sloppy prefix match.
    setCookie("auth_hint=10");
    expect(hasAuthHint()).toBe(false);
  });

  test("ignores a cookie whose name merely contains auth_hint as a substring", () => {
    // (?:^|;\s*) anchors to a real boundary so not_auth_hint never counts.
    setCookie("not_auth_hint=1");
    expect(hasAuthHint()).toBe(false);
  });

  test("false when document is undefined (SSR / no client context)", () => {
    delete (globalThis as { document?: DocLike }).document;
    expect(hasAuthHint()).toBe(false);
  });
});
