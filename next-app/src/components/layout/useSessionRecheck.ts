"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";
import { dueForRecheck, sessionEnded } from "@/lib/sessionRecheck";

/**
 * While the reader is signed in, ask again whether they still are each time
 * the tab is shown or focused (at most every SESSION_RECHECK_MS), and call
 * `onEnded` once the answer is no. See lib/sessionRecheck for why an open
 * page needs this and how the answer is read.
 *
 * The probe goes through authFetch, so an access token that merely expired
 * is refreshed on the way and the reader stays signed in; only a session
 * go-api has ended comes back as ended.
 */
export function useSessionRecheck(signedIn: boolean, onEnded: () => void): void {
  // The first time the tab is shown or focused it asks at once — the reader
  // coming back to a page left open is exactly the moment that matters —
  // and then at most once per interval.
  const lastProbeAt = useRef(0);
  // Bumped whenever the listeners come down (signed out, unmounted), so a
  // probe still out at that moment cannot act on a state that has gone —
  // e.g. turn a logout, which deliberately stays on the page, into a trip
  // to /login.
  const generation = useRef(0);

  const recheck = useEffectEvent(async () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (!dueForRecheck(now, lastProbeAt.current)) return;
    lastProbeAt.current = now;
    const asked = generation.current;
    try {
      const r = await authFetch("/api/auth/me", { skipRedirectOnFailure: true });
      if (asked !== generation.current) return;
      if (sessionEnded(r.status, hasAuthHint())) onEnded();
    } catch {
      /* network blip — keep the last known state */
    }
  });

  useEffect(() => {
    if (!signedIn) return;
    const onShow = () => void recheck();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      generation.current += 1;
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [signedIn]);
}
