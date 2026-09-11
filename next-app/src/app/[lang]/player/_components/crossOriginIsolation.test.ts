import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gate that keeps cross-origin isolation from coming back.
//
// It was here twice. nginx sent Cross-Origin-Opener-Policy + Cross-Origin-
// Embedder-Policy site-wide so /player could use SharedArrayBuffer, and
// jassubOverlay.ts refused to mount unless `crossOriginIsolated` was true.
// Both rested on a claim that was never measured: that jassub's pthread
// workers hang without SAB. They do not — the emscripten loader sizes the
// pthread pool to zero when the page is not isolated and renders
// single-threaded (measured 2026-09-12: `ready` in 147ms, ASS painted).
//
// What the headers did do was block the YouTube trailer iframe on the detail
// page. A per-route exemption (#174) could not fix that: COOP/COEP are
// document-level, and Next's client-side navigation never fetches a new
// document, so a visitor clicking from the home page into /anime/<id> kept
// the home page's isolation. Only a hard load ever saw the exemption.
//
// Two assertions, one per place the isolation used to live. The header check
// reads the nginx configs the compose file mounts, because that is where the
// policy is actually emitted — next.config.ts sets no headers at all, so a
// test against the Next app alone would pass in either state.

const REPO_ROOT = join(import.meta.dir, "../../../../../..");
const NGINX_CONFS = ["default.conf", "default.legacy.conf", "default.p9.conf"];

const ISOLATION_HEADER =
  /^\s*add_header\s+Cross-Origin-(?:Opener|Embedder)-Policy\b/m;

describe("cross-origin isolation stays off", () => {
  for (const conf of NGINX_CONFS) {
    test(`nginx/${conf} emits neither COOP nor COEP`, () => {
      const text = readFileSync(join(REPO_ROOT, "nginx", conf), "utf8");
      expect(text).not.toMatch(ISOLATION_HEADER);
    });
  }

  test("jassubOverlay does not bail out on crossOriginIsolated", () => {
    const src = readFileSync(join(import.meta.dir, "jassubOverlay.ts"), "utf8");
    // The old gate was `if (... !crossOriginIsolated) { ...; return null; }`.
    // Match the condition, not the comment that now explains its absence.
    expect(src).not.toMatch(/if\s*\([^)]*crossOriginIsolated/);
  });
});
