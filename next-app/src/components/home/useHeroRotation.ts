"use client";

// Wires the hero's automatic rotation to the page: what holds it, and the two
// timers a running countdown arms. The rules themselves — which holds exist,
// what a hold does to the countdown, what starts it over — are in
// lib/home/heroRotation.ts; this file only reports the holds and arms timers.
//
// Every value the hero renders from is React state or an external store read
// with useSyncExternalStore, set from event callbacks — never synchronously in
// an effect body. The countdown itself lives in a ref: nothing renders from
// it (the bar's progress fill is a CSS animation paused by the same holds).

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  canRotate,
  countdownFor,
  countdownKey,
  countdownTimers,
  holdCountdown,
  isHeld,
  nextSlide,
  resumeCountdown,
  type SavedCountdown,
} from "@/lib/home/heroRotation";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
// The server cannot know. Assuming reduced motion there keeps the server HTML
// and the hydration pass still — no countdown, no pause button — and the
// browser's real answer arrives in the render right after.
const reducedMotionOnServer = () => true;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const tabHidden = () => document.visibilityState === "hidden";
const tabHiddenOnServer = () => false;

/**
 * Keyboard focus, not any focus: a mouse click leaves the clicked button
 * focused, and a hold that outlived the pointer would keep the hero still
 * after the reader pressed play. Mouse readers are covered by the hover hold.
 */
function isKeyboardFocus(el: EventTarget): boolean {
  if (!(el instanceof Element)) return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    // A browser that cannot parse :focus-visible: hold on any focus.
    return true;
  }
}

export interface HeroRotation {
  /** The hero rotates on this device at all (more than one slide, motion allowed). */
  rotates: boolean;
  /** Something holds it right now. Always true when it does not rotate. */
  held: boolean;
  /** The reader pressed pause. */
  paused: boolean;
  togglePause: () => void;
  /** Changes when the current slide's 8 seconds start over without a switch. */
  restarts: number;
  /** For the hero's root element: the hover and focus holds. */
  rootHandlers: {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
    onFocus: (e: FocusEvent<HTMLElement>) => void;
    onBlur: (e: FocusEvent<HTMLElement>) => void;
  };
}

interface HeroRotationOptions {
  /** The hero's root element, watched for being scrolled out of view. */
  rootRef: RefObject<HTMLElement | null>;
  count: number;
  current: number;
  /** Start loading slide `index`'s banner. */
  onPreload: (index: number) => void;
  /** Switch to slide `index` — the timer ran out. */
  onAdvance: (index: number) => void;
}

export function useHeroRotation({ rootRef, count, current, onPreload, onAdvance }: HeroRotationOptions): HeroRotation {
  const saved = useRef<SavedCountdown | null>(null);
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [paused, setPaused] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  const [restarts, setRestarts] = useState(0);
  const hidden = useSyncExternalStore(subscribeVisibility, tabHidden, tabHiddenOnServer);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, reducedMotionOnServer);

  const rotates = canRotate(count, reducedMotion);
  const held = !rotates || isHeld({ pointer, focus, paused, hidden, offscreen });
  const key = countdownKey(current, restarts);

  // Back from the background: this slide's 8 seconds start over.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") setRestarts((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Scrolled out of view: hold. The first report arrives asynchronously, with
  // the hero's position at the time — a reload that restores a scrolled page
  // holds from there.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef]);

  const preload = useEffectEvent((index: number) => onPreload(index));
  const advance = useEffectEvent((index: number) => onAdvance(index));

  // The countdown. A layout effect so the timers are armed in the same task
  // that commits the change which released the hold: from the moment the page
  // shows the hero running, the countdown is counting.
  useLayoutEffect(() => {
    if (!rotates) return;
    const start = countdownFor(saved.current, key);
    if (held) {
      saved.current = { key, countdown: start };
      return;
    }
    const now = performance.now();
    const running = resumeCountdown(start, now);
    saved.current = { key, countdown: running };
    const { preloadInMs, advanceInMs } = countdownTimers(running, now);
    const next = nextSlide(current, count);
    const preloadTimer = window.setTimeout(() => preload(next), preloadInMs);
    const advanceTimer = window.setTimeout(() => advance(next), advanceInMs);
    return () => {
      window.clearTimeout(preloadTimer);
      window.clearTimeout(advanceTimer);
      saved.current = { key, countdown: holdCountdown(running, performance.now()) };
    };
  }, [rotates, held, key, current, count]);

  return {
    rotates,
    held,
    paused,
    togglePause: () => setPaused((p) => !p),
    restarts,
    rootHandlers: {
      onPointerEnter: (e) => {
        if (e.pointerType !== "touch") setPointer(true);
      },
      onPointerLeave: (e) => {
        if (e.pointerType !== "touch") setPointer(false);
      },
      onFocus: (e) => setFocus(isKeyboardFocus(e.target)),
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      },
    },
  };
}
