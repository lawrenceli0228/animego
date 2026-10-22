import { describe, expect, test } from "bun:test";
import { SESSION_RECHECK_MS, dueForRecheck, sessionEnded } from "./sessionRecheck";

describe("sessionEnded", () => {
  test("a 401 after go-api cleared auth_hint: the session behind this tab has ended", () => {
    expect(sessionEnded(401, false)).toBe(true);
  });

  // authFetch answers 401 whenever its refresh fails, including a refresh
  // that failed on go-api's side (5xx, 429). go-api clears auth_hint only
  // when it refuses the refresh token for good, so a hint that is still set
  // means "could not tell", not "signed out".
  test("a 401 with auth_hint still set is not a verdict", () => {
    expect(sessionEnded(401, true)).toBe(false);
  });

  test("anything but a 401 leaves the reader signed in", () => {
    for (const status of [200, 304, 429, 500, 503]) {
      expect(sessionEnded(status, false)).toBe(false);
    }
  });
});

describe("dueForRecheck", () => {
  test("asks again once the interval has passed since the last probe", () => {
    expect(dueForRecheck(10_000 + SESSION_RECHECK_MS, 10_000)).toBe(true);
  });

  test("does not ask on every focus or tab switch", () => {
    expect(dueForRecheck(10_000 + SESSION_RECHECK_MS - 1, 10_000)).toBe(false);
  });
});
