import { describe, expect, test } from "bun:test";
import { loggedInFromCookies } from "./serverAuth";

// Minimal stand-in for ReadonlyRequestCookies — only `.has` is used.
function store(names: string[]): { has(name: string): boolean } {
  const set = new Set(names);
  return { has: (n: string) => set.has(n) };
}

describe("loggedInFromCookies", () => {
  test("true when only the session cookie is present", () => {
    expect(loggedInFromCookies(store(["session"]))).toBe(true);
  });

  test("true when only refreshToken is present (expired access, valid refresh)", () => {
    expect(loggedInFromCookies(store(["refreshToken"]))).toBe(true);
  });

  test("true when both auth cookies are present", () => {
    expect(loggedInFromCookies(store(["session", "refreshToken"]))).toBe(true);
  });

  test("false when neither auth cookie is present (logged-out SEO visitor)", () => {
    expect(loggedInFromCookies(store([]))).toBe(false);
  });

  test("false when only unrelated cookies are present (lang/theme)", () => {
    expect(loggedInFromCookies(store(["lang", "theme"]))).toBe(false);
  });

  test("ignores cookies whose names merely contain the substring", () => {
    // Guard against a sloppy `.includes`-style rewrite: a `my-session-x`
    // cookie must NOT count as a real `session`.
    expect(loggedInFromCookies(store(["my-session-x", "xrefreshToken"]))).toBe(
      false,
    );
  });
});
