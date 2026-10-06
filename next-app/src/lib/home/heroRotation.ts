// The homepage hero's automatic rotation, as rules and arithmetic.
//
// The hero moves to the next of its five slides every 8 seconds. Anything
// that moves on its own for longer than five seconds needs a way to stop it
// (WCAG 2.2.2, Pause, Stop, Hide), so the rotation is held by:
//
//   - a mouse resting on the hero, and keyboard focus anywhere inside it —
//     when both end it carries on from where it was;
//   - the pause button, until it is pressed again;
//   - a tab in the background — and when the tab comes back the slide's
//     8 seconds start over, because the reader has been away;
//   - the hero being scrolled out of view. The focused slide colours the whole
//     page, so a rotation nobody can see would still re-tint the section the
//     reader is looking at.
//
// Under prefers-reduced-motion it does not rotate at all. A switch — by hand
// or by the timer — starts the new slide's 8 seconds from zero.
//
// A hold pauses the countdown rather than restarting it: the time a slide has
// already run is banked and the countdown resumes with what is left. The bar's
// progress fill is a CSS animation that pauses under the same holds, so the
// two agree without the component rendering on every frame.
//
// Pure: no React, no DOM, no clock of its own — `now` is always passed in.

/** How long each slide stays in focus while the hero rotates. */
export const HERO_INTERVAL_MS = 8_000;

/**
 * How long before an automatic switch the next slide's banner starts to load.
 * Banners are fetched only for slides that are about to be shown; without the
 * lead, the next one would arrive after its own crossfade and pop in.
 */
export const HERO_PRELOAD_LEAD_MS = 2_500;

/** Everything that can hold the rotation. Any one of them holds it. */
export interface HeroHolds {
  /** A mouse (or pen) is over the hero. A touch is not a hover. */
  readonly pointer: boolean;
  /** Keyboard focus is somewhere inside the hero. */
  readonly focus: boolean;
  /** The reader pressed pause. */
  readonly paused: boolean;
  /** The tab is in the background. */
  readonly hidden: boolean;
  /** The hero is scrolled entirely out of view. */
  readonly offscreen: boolean;
}

export function isHeld(holds: HeroHolds): boolean {
  return holds.pointer || holds.focus || holds.paused || holds.hidden || holds.offscreen;
}

/**
 * Whether the hero rotates on its own at all: never with one slide, and never
 * for a reader who asked for reduced motion.
 */
export function canRotate(slideCount: number, reducedMotion: boolean): boolean {
  return slideCount > 1 && !reducedMotion;
}

/** The current slide's countdown. */
export interface Countdown {
  /** Time this slide has already run, banked across holds. */
  readonly spentMs: number;
  /** When the current running stretch began; null while held. */
  readonly runningSince: number | null;
}

export const FRESH_COUNTDOWN: Countdown = { spentMs: 0, runningSince: null };

/** Start (or carry on) counting at `now`. Already running: unchanged. */
export function resumeCountdown(c: Countdown, now: number): Countdown {
  return c.runningSince === null ? { spentMs: c.spentMs, runningSince: now } : c;
}

/** Stop counting at `now`, banking what ran. Already held: unchanged. */
export function holdCountdown(c: Countdown, now: number): Countdown {
  if (c.runningSince === null) return c;
  return { spentMs: c.spentMs + Math.max(0, now - c.runningSince), runningSince: null };
}

/** What is left of the slide's interval at `now`; never negative. */
export function remainingMs(c: Countdown, now: number): number {
  const running = c.runningSince === null ? 0 : Math.max(0, now - c.runningSince);
  return Math.max(0, HERO_INTERVAL_MS - c.spentMs - running);
}

export interface CountdownTimers {
  /** Until the next slide's banner should start loading. */
  readonly preloadInMs: number;
  /** Until the switch. */
  readonly advanceInMs: number;
}

/** The two timers a running countdown needs, measured from `now`. */
export function countdownTimers(c: Countdown, now: number): CountdownTimers {
  const advanceInMs = remainingMs(c, now);
  return { preloadInMs: Math.max(0, advanceInMs - HERO_PRELOAD_LEAD_MS), advanceInMs };
}

/** The slide after `current`, wrapping to the first after the last. */
export function nextSlide(current: number, count: number): number {
  return count > 0 ? (current + 1) % count : 0;
}

/**
 * Which slide's countdown is running: the slide, and how many times the tab
 * has come back from the background. Either one changing starts a fresh
 * countdown — a switch by hand or by the timer, or a return to the tab.
 */
export function countdownKey(slide: number, returns: number): string {
  return `${slide}:${returns}`;
}

export interface SavedCountdown {
  readonly key: string;
  readonly countdown: Countdown;
}

/**
 * The countdown to carry on with for `key`: the banked one when it belongs to
 * the same slide and the same visit to the tab, a fresh one otherwise.
 */
export function countdownFor(saved: SavedCountdown | null, key: string): Countdown {
  return saved !== null && saved.key === key ? saved.countdown : FRESH_COUNTDOWN;
}
