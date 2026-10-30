// The activity panel's window picker, mounted in a real DOM with a fetch the
// test answers by hand: whether the panel says it is loading, and what the
// picker shows, after a switch that answered, failed, or was superseded.
// renderToStaticMarkup runs no effects, so ActivitySection.render.test.tsx
// cannot see any of this. Runs in its own bun process (domSuites.test.ts).
//
// Every fixture is synthetic.

import { button, click, holdFetch, mount, settle, unmountAll } from "@/lib/test-utils/domHarness";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AdminActivityPanel, AdminActivityWindow } from "../_types/activity";

const { ActivitySection } = await import("./ActivitySection");

const TODAY = "2030-06-12";

function win(days: number): AdminActivityWindow {
  return {
    days,
    active: 20,
    returning: 12,
    signupOnly: 8,
    prevActive: 22,
    prevReturning: 15,
    prevSignupOnly: 7,
    reconstructed: false,
    prevReconstructed: false,
  };
}

function panel(days: number): AdminActivityPanel {
  const end = Date.UTC(2030, 5, 12);
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date, returning: 3, signupDay: 1, requests: 10, logins: 0, instrumented: true, partial: date === TODAY };
  });
  return {
    days,
    timezone: "Asia/Shanghai (UTC+8)",
    today: TODAY,
    asOf: "2030-06-12 09:41",
    instrumentedSince: "2030-01-01",
    todayActive: { active: 4, sameTimeYesterday: 3, sameTimeLastWeek: 2, yesterdayTotal: 6 },
    windows: { d7: win(7), d30: win(30) },
    signups30: { count: 5, prevCount: 4, returnedAfter: 2, reconstructed: false },
    daily,
    depth: {
      days,
      total: 10,
      signupOnly: 3,
      reconstructed: false,
      buckets: [
        { min: 1, max: 1, count: 5 },
        { min: 2, max: 2, count: 3 },
        { min: 3, max: 6, count: 2 },
        { min: 7, max: 7, count: 0 },
      ],
    },
    cohorts: [],
  };
}

let net: ReturnType<typeof holdFetch>;
let host: HTMLElement;

beforeEach(async () => {
  net = holdFetch();
  host = await mount(<ActivitySection initial={panel(30)} />);
});

afterEach(async () => {
  await unmountAll();
  net.restore();
});

const section = () => host.querySelector("section");
const busy = () => section()?.getAttribute("aria-busy");
const saysLoading = () => (section()?.textContent ?? "").includes("加载中");
const pressed = () => host.querySelector('[role="group"] [aria-pressed="true"]')?.textContent;
const bars = () => host.querySelectorAll("button[data-date]").length;
const lastRequest = () => net.requests[net.requests.length - 1];

describe("the window picker", () => {
  test("a switch that answers draws the new window and stops loading", async () => {
    await click(button(host, "90 天"));
    expect(busy()).toBe("true");
    expect(saysLoading()).toBe(true);

    await lastRequest().respond({ data: panel(90) });

    expect(busy()).toBe("false");
    expect(saysLoading()).toBe(false);
    expect(bars()).toBe(90);
  });

  test("90, then back to 30 before it answers: nothing is left loading", async () => {
    await click(button(host, "90 天"));
    await click(button(host, "30 天"));
    await settle();

    expect(net.requests.map((r) => [r.url, r.aborted])).toEqual([["/api/admin/activity?days=90", true]]);
    expect(busy()).toBe("false");
    expect(saysLoading()).toBe(false);
    expect(pressed()).toBe("30 天");
    expect(bars()).toBe(30);
  });

  test("a failed switch goes back to the window on screen and says so", async () => {
    await click(button(host, "90 天"));

    await lastRequest().respond({ error: { code: "SERVER_ERROR", message: "boom" } }, 500);

    expect(pressed()).toBe("30 天");
    expect(busy()).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("切换到 90 天失败");
  });

  test("trying the failed window again is loading again", async () => {
    await click(button(host, "90 天"));
    await lastRequest().respond({ error: { code: "SERVER_ERROR", message: "boom" } }, 500);

    await click(button(host, "90 天"));

    expect(busy()).toBe("true");
    expect(saysLoading()).toBe(true);
    await lastRequest().respond({ data: panel(90) });
    expect(busy()).toBe("false");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(bars()).toBe(90);
  });
});
