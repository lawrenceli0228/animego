import { describe, expect, test } from "bun:test";
import { authChrome } from "./authChrome";

// Locks the phantom-logout fix invariant: while the auth probe is in flight and
// we are not yet authenticated, the chrome is the neutral "probing" placeholder
// — NEVER "anonymous" (the login CTA). A regression that drops the probing
// branch (back to `user ? avatar : cta`) makes authChrome(false, true) return
// "anonymous", which this suite catches. The React wiring (effect timing,
// cancellation) is exercised by E2E; this pins the render decision.

describe("authChrome", () => {
  test("a resolved session always wins, even mid-probe", () => {
    expect(authChrome(true, true)).toBe("authed");
    expect(authChrome(true, false)).toBe("authed");
  });

  test("INVARIANT: not authed + probe in flight → 'probing', never the CTA", () => {
    expect(authChrome(false, true)).toBe("probing");
    // The bug this guards against: a logged-in visitor must not see "anonymous"
    // (the login button) while their /api/auth/me probe is still resolving.
    expect(authChrome(false, true)).not.toBe("anonymous");
  });

  test("not authed + probe resolved → 'anonymous' (login CTA)", () => {
    expect(authChrome(false, false)).toBe("anonymous");
  });
});
