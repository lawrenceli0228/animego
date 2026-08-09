import { describe, expect, test } from "bun:test";
import {
  detailTarget,
  loginTarget,
  quickSubscribeMode,
} from "./quickSubscribeState";

// The button's decisions — "what does this press mean?" and "where does it
// send the visitor?" — are pure, so they get tested here. The rendering itself
// (pill styling, 44px hit box, aria wiring) is verified visually; this repo has
// no RTL and markup assertions on inline-styled JSX buy nothing.

describe("quickSubscribeMode", () => {
  test("signed in and not tracking → add", () => {
    expect(quickSubscribeMode(true, false)).toBe("add");
  });

  test("signed in and already tracking → open, never remove", () => {
    expect(quickSubscribeMode(true, true)).toBe("open");
  });

  test("not known → signedOut, whatever the stale set says", () => {
    // known=false covers anonymous visitors, a missing provider, and a session
    // that 401'd mid-visit. Showing ✓ off a set we can no longer write to
    // would promise a mutation that silently fails.
    expect(quickSubscribeMode(false, false)).toBe("signedOut");
    expect(quickSubscribeMode(false, true)).toBe("signedOut");
  });

  test("no input combination produces a destructive mode", () => {
    // THE rule of this control: the poster corner never deletes. The set it
    // reads is unfiltered (GET /api/subscriptions returns completed and
    // dropped rows too), so a show finished last year with a 10/10 score
    // renders ✓ in an unrelated search grid — and DELETE drops the whole row,
    // score and episode progress included. Only the detail page, which shows
    // what is at stake, is allowed to offer that.
    // Typed as string[] on purpose: "remove" is not in the union any more, so
    // the assertion has to be able to name a value the type forbids.
    const modes: string[] = [];
    for (const known of [true, false]) {
      for (const subscribed of [true, false]) {
        modes.push(quickSubscribeMode(known, subscribed));
      }
    }
    expect(modes).not.toContain("remove");
    expect(new Set(modes)).toEqual(new Set(["add", "open", "signedOut"]));
  });
});

describe("detailTarget", () => {
  test("✓ points at the surface that owns the other subscription verbs", () => {
    // Status picker, episode counter, score and an explicit Remove all live
    // there, behind a page load that shows the user what they are about to
    // change.
    expect(detailTarget(20661)).toBe("/anime/20661");
  });
});

describe("loginTarget", () => {
  test("round-trips the visitor back to the grid they pressed + on", () => {
    expect(loginTarget("/seasonal/summer/2026", "")).toBe(
      "/login?from=%2Fseasonal%2Fsummer%2F2026",
    );
  });

  test("preserves the query string so filters and pagination survive", () => {
    // Losing ?q= would land the user on an empty /search and the pending
    // write would complete against a poster they can no longer see.
    expect(loginTarget("/search", "?q=frieren&genre=Fantasy&page=2")).toBe(
      "/login?from=%2Fsearch%3Fq%3Dfrieren%26genre%3DFantasy%26page%3D2",
    );
  });

  test("encodes non-ASCII queries", () => {
    expect(loginTarget("/search", "?q=葬送")).toBe(
      "/login?from=%2Fsearch%3Fq%3D%E8%91%AC%E9%80%81",
    );
  });

  test("home page", () => {
    expect(loginTarget("/", "")).toBe("/login?from=%2F");
  });

  test("falls back to / when there is nothing to go back to", () => {
    // A blank `from` would fail the server-side sanitizeFromParam check and
    // strand the user on the login page after a successful sign-in.
    expect(loginTarget("", "")).toBe("/login?from=%2F");
  });
});
