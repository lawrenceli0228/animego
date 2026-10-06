import { describe, expect, test } from "bun:test";
import {
  FRESH_COUNTDOWN,
  HERO_INTERVAL_MS,
  HERO_PRELOAD_LEAD_MS,
  canRotate,
  countdownFor,
  countdownKey,
  countdownTimers,
  holdCountdown,
  isHeld,
  nextSlide,
  remainingMs,
  resumeCountdown,
  type HeroHolds,
} from "./heroRotation";

// The hero's rotation, held to WCAG 2.2.2: every reason it may hold, the
// countdown that a hold pauses rather than restarts, the restarts that a
// switch and a return to the tab cause, and the two timers it arms.

const FREE: HeroHolds = { pointer: false, focus: false, paused: false, hidden: false, offscreen: false };

describe("isHeld", () => {
  test("nothing holding it: the hero rotates", () => {
    expect(isHeld(FREE)).toBe(false);
  });

  test.each(Object.keys(FREE) as Array<keyof HeroHolds>)("%s alone holds it", (reason) => {
    expect(isHeld({ ...FREE, [reason]: true })).toBe(true);
  });

  test("it stays held until every hold has ended", () => {
    // Pointer off the hero but keyboard focus still inside.
    expect(isHeld({ ...FREE, focus: true })).toBe(true);
    expect(isHeld({ ...FREE, pointer: true, focus: true })).toBe(true);
  });
});

describe("canRotate", () => {
  test("rotates with two or more slides and motion allowed", () => {
    expect(canRotate(5, false)).toBe(true);
    expect(canRotate(2, false)).toBe(true);
  });

  test("never under reduced motion, however many slides", () => {
    expect(canRotate(5, true)).toBe(false);
  });

  test("never with nothing to rotate to", () => {
    expect(canRotate(1, false)).toBe(false);
    expect(canRotate(0, false)).toBe(false);
  });
});

describe("the countdown", () => {
  test("a fresh one has the whole interval", () => {
    expect(remainingMs(FRESH_COUNTDOWN, 123_456)).toBe(HERO_INTERVAL_MS);
  });

  test("a running one counts down from when it resumed", () => {
    const running = resumeCountdown(FRESH_COUNTDOWN, 1_000);
    expect(remainingMs(running, 1_000)).toBe(8_000);
    expect(remainingMs(running, 4_000)).toBe(5_000);
  });

  test("a hold pauses it: the time already run is banked, not thrown away", () => {
    const running = resumeCountdown(FRESH_COUNTDOWN, 0);
    const held = holdCountdown(running, 3_000);
    expect(held).toEqual({ spentMs: 3_000, runningSince: null });
    // Held for a minute: nothing moves.
    expect(remainingMs(held, 63_000)).toBe(5_000);
    // Resumed: it carries on with the 5 seconds that were left.
    const resumed = resumeCountdown(held, 63_000);
    expect(remainingMs(resumed, 65_000)).toBe(3_000);
  });

  test("several holds add up", () => {
    let c = resumeCountdown(FRESH_COUNTDOWN, 0);
    c = holdCountdown(c, 2_000);
    c = resumeCountdown(c, 10_000);
    c = holdCountdown(c, 13_000);
    expect(c.spentMs).toBe(5_000);
    expect(remainingMs(c, 99_000)).toBe(3_000);
  });

  test("resuming a running countdown and holding a held one change nothing", () => {
    const running = resumeCountdown(FRESH_COUNTDOWN, 500);
    expect(resumeCountdown(running, 2_000)).toBe(running);
    const held = holdCountdown(running, 1_500);
    expect(holdCountdown(held, 9_000)).toBe(held);
  });

  test("never reports less than nothing left", () => {
    const running = resumeCountdown(FRESH_COUNTDOWN, 0);
    expect(remainingMs(running, 20_000)).toBe(0);
    // A clock that went backwards does not add time either.
    expect(remainingMs(running, -5_000)).toBe(HERO_INTERVAL_MS);
  });
});

describe("countdownTimers", () => {
  test("a fresh slide preloads the next banner shortly before it switches", () => {
    const running = resumeCountdown(FRESH_COUNTDOWN, 0);
    expect(countdownTimers(running, 0)).toEqual({
      preloadInMs: HERO_INTERVAL_MS - HERO_PRELOAD_LEAD_MS,
      advanceInMs: HERO_INTERVAL_MS,
    });
    expect(HERO_PRELOAD_LEAD_MS).toBeLessThan(HERO_INTERVAL_MS);
  });

  test("resumed late in its interval, it preloads at once", () => {
    const late = resumeCountdown({ spentMs: 7_000, runningSince: null }, 50_000);
    expect(countdownTimers(late, 50_000)).toEqual({ preloadInMs: 0, advanceInMs: 1_000 });
  });
});

describe("nextSlide", () => {
  test("moves along and wraps after the last", () => {
    expect(nextSlide(0, 5)).toBe(1);
    expect(nextSlide(3, 5)).toBe(4);
    expect(nextSlide(4, 5)).toBe(0);
  });

  test("an empty set has nowhere to go", () => {
    expect(nextSlide(0, 0)).toBe(0);
  });
});

describe("countdownFor — what starts the 8 seconds over", () => {
  const banked = { spentMs: 6_000, runningSince: null };

  test("the same slide on the same visit to the tab carries on", () => {
    const key = countdownKey(2, 0);
    expect(countdownFor({ key, countdown: banked }, key)).toBe(banked);
  });

  test("a different slide — switched by hand or by the timer — starts over", () => {
    expect(countdownFor({ key: countdownKey(2, 0), countdown: banked }, countdownKey(3, 0))).toBe(FRESH_COUNTDOWN);
  });

  test("the same slide after the tab came back from the background starts over", () => {
    expect(countdownFor({ key: countdownKey(2, 0), countdown: banked }, countdownKey(2, 1))).toBe(FRESH_COUNTDOWN);
  });

  test("nothing saved yet: a fresh countdown", () => {
    expect(countdownFor(null, countdownKey(0, 0))).toBe(FRESH_COUNTDOWN);
  });

  test("keys tell slide and visit apart", () => {
    expect(countdownKey(1, 12)).not.toBe(countdownKey(11, 2));
  });
});
