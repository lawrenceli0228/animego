"use client";

// The homepage's clock: the server's render time in the site's zone during
// SSR and hydration, then the browser's own minute in the browser's own zone.
//
// Same shape as NextAiringBadge's useClientMinute, with one addition: the
// server snapshot is a real time rather than "unknown". The homepage is
// force-dynamic, so its render time is minutes-fresh, and giving the server a
// clock is what lets the "now" marker and the aired badges be right in the
// first paint instead of popping in after hydration. getServerSnapshot returns
// 0 on both sides of hydration, so React renders the server's answer first
// and switches to the client's without a mismatch — no effect, no setState.

import { useSyncExternalStore } from "react";
import { SITE_TZ } from "@/lib/home/time";

const TICK_MS = 60_000;

/** Fire on each minute boundary, so "现在 20:40" turns over when the wall clock does. */
function subscribeMinute(onChange: () => void): () => void {
  let id: ReturnType<typeof setTimeout>;
  const schedule = () => {
    id = setTimeout(() => {
      onChange();
      schedule();
    }, TICK_MS - (Date.now() % TICK_MS) + 50);
  };
  schedule();
  return () => clearTimeout(id);
}

const clientMinute = () => Math.floor(Date.now() / TICK_MS);
const serverMinute = () => 0;

export interface HomeClock {
  nowMs: number;
  /** The site's zone before hydration, the runtime's own (undefined) after. */
  timeZone: string | undefined;
}

export function useHomeClock(serverNowMs: number): HomeClock {
  const minute = useSyncExternalStore(subscribeMinute, clientMinute, serverMinute);
  return minute === 0
    ? { nowMs: serverNowMs, timeZone: SITE_TZ }
    : { nowMs: minute * TICK_MS, timeZone: undefined };
}
