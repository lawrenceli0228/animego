"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/lib/lang-client";
import "./stale-tab-notice.css";

/**
 * Tells a tab that has outlived the deployment it was loaded from.
 *
 * The failure it exists for is already in Sentry: `Cannot read properties of
 * undefined (reading 'call')` on /anime/:id, which is what a client-side
 * navigation looks like when it asks for a chunk the running deployment no
 * longer has. The tab is not broken until the reader touches it, and then it
 * breaks in a way that reads as "the site is broken" rather than "reload me".
 *
 * ## What it can and cannot do
 *
 * It cannot warn the tabs open during the deploy that ships it — those tabs
 * are running the previous build, which has no such check. Every deploy after
 * this one is covered; this one is not, and no ordering changes that.
 *
 * ## Why visibilitychange rather than a timer
 *
 * A stale tab is harmless until someone comes back to it, and coming back is
 * exactly what fires this event. Polling would cost every reader a request
 * every N seconds forever to catch a manual deploy that happens rarely — and
 * would still not fire at a more useful moment than this one. The trade is
 * that a tab held in the foreground the whole time is not told; it is also the
 * tab least likely to be mid-navigation when the deploy lands.
 */

// The build this bundle came from, inlined by next.config.ts's `env`.
const OWN_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

// Two returns to the tab inside this window ask once. Guards against a reader
// alt-tabbing repeatedly, and against browsers that fire visibilitychange more
// than once for a single switch.
const MIN_CHECK_INTERVAL_MS = 60_000;

export function StaleTabNotice() {
  const { t } = useLang();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // No id means the build did not inline one — a misconfiguration, and one
    // where every comparison would fail and every reader would be told to
    // refresh. Doing nothing is the correct failure.
    if (!OWN_BUILD_ID) return;

    let lastCheck = 0;
    let cancelled = false;

    async function check() {
      const now = Date.now();
      if (now - lastCheck < MIN_CHECK_INTERVAL_MS) return;
      lastCheck = now;
      try {
        const res = await fetch("/version.json", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId } = (await res.json()) as { buildId?: string | null };
        // Only a positive mismatch counts. A missing or unreadable id is the
        // network being unhelpful, not a deploy.
        if (!cancelled && buildId && buildId !== OWN_BUILD_ID) setStale(true);
      } catch {
        // Offline, or the deploy is mid-restart and nginx is answering 502.
        // Either way this is not evidence of anything; try again next time.
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") void check();
    }

    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale) return null;

  return (
    <div className="agc-stale-tab" role="status">
      <div className="agc-stale-tab-card">
        <span className="agc-stale-tab-text">{t("app.updateAvailable")}</span>
        <button
          type="button"
          className="agc-stale-tab-reload"
          onClick={() => window.location.reload()}
        >
          {t("app.reload")}
        </button>
        <button
          type="button"
          className="agc-stale-tab-close"
          aria-label={t("app.dismissUpdate")}
          // Dismissal lasts for this page load only, deliberately. The tab is
          // still stale, and a reader who dismisses and then navigates gets
          // the chunk error this exists to prevent — so it comes back on the
          // next load rather than being remembered forever.
          onClick={() => setStale(false)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
