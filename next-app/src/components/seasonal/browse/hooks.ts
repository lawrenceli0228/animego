"use client";

// The two outside facts the browse tree reads during render: what time it is,
// and whether the screen is a phone's. Both through useSyncExternalStore, so
// the server's answer is what hydration renders and the browser's answer
// arrives as an ordinary update right after — no effect, no setState, no
// mismatch.

import { useSyncExternalStore } from "react";
import type { Layout } from "@/lib/seasonal/batch";

// ── The clock ───────────────────────────────────────────────────────────────

/** Countdowns read in minutes; half a minute is fresh enough and cheap. */
const TICK_MS = 30_000;

/** Fire on each 30-second boundary, so every countdown on the page turns over together. */
function subscribeTick(onChange: () => void): () => void {
  let id: ReturnType<typeof setTimeout>;
  const schedule = () => {
    id = setTimeout(
      () => {
        onChange();
        schedule();
      },
      TICK_MS - (Date.now() % TICK_MS) + 50,
    );
  };
  schedule();
  return () => clearTimeout(id);
}

const clientTick = () => Math.floor(Date.now() / TICK_MS);
const serverTick = () => 0;

/**
 * "Now", in epoch ms: the server's render time through hydration, then the
 * browser's clock, re-read every 30 seconds.
 */
export function useSeasonClock(serverNowMs: number): number {
  const tick = useSyncExternalStore(subscribeTick, clientTick, serverTick);
  return tick === 0 ? serverNowMs : tick * TICK_MS;
}

// ── The layout ──────────────────────────────────────────────────────────────

/** Where the phone layout starts — the same number as every ≤600px rule in the stylesheets. */
const PHONE_QUERY = "(max-width: 600px)";

function subscribeLayout(onChange: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const clientIsPhone = () => window.matchMedia(PHONE_QUERY).matches;
const serverIsPhone = () => false;

/**
 * The batch sizes and the views on offer follow the layout. The server cannot
 * know the screen, so the first paint is the desktop's (CSS lays it out for
 * whatever screen it is) and a phone narrows the batch right after hydration,
 * below the fold.
 */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, clientIsPhone, serverIsPhone) ? "phone" : "desktop";
}
