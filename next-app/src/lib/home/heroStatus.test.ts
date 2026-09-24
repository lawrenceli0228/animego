import { describe, expect, test } from "bun:test";
import { heroStatusParts, statusText, upcomingAiring } from "./heroStatus";

const NOW = 1_000_000;
const copy = { epUpdate: "更新第 {{ep}} 集", totalEps: "共 {{n}} 集" };
const when = (ms: number) => `T${ms}`;

describe("upcomingAiring", () => {
  test("is the first airing strictly after now", () => {
    expect(
      upcomingAiring(
        [
          { at: NOW - 10, ep: 3 },
          { at: NOW + 50, ep: 5 },
          { at: NOW + 20, ep: 4 },
        ],
        NOW,
      ),
    ).toEqual({ at: NOW + 20, ep: 4 });
  });

  test("an episode going out right now is no longer upcoming", () => {
    expect(upcomingAiring([{ at: NOW, ep: 3 }], NOW)).toBeNull();
  });

  test("none known", () => {
    expect(upcomingAiring([], NOW)).toBeNull();
  });
});

describe("heroStatusParts", () => {
  test("airing with a known next episode", () => {
    const parts = heroStatusParts(
      { status: "RELEASING", statusLabel: "连载中", episodes: 14, airings: [{ at: NOW + 100, ep: 14 }] },
      NOW,
      when,
      copy,
    );
    expect(parts).toEqual({ label: "连载中", when: `T${NOW + 100}`, detail: "更新第 14 集", live: true });
    expect(statusText(parts)).toBe(`连载中 · T${NOW + 100} 更新第 14 集`);
  });

  test("airing, next episode unknown: just the status, still live", () => {
    const parts = heroStatusParts({ status: "RELEASING", statusLabel: "连载中", episodes: null, airings: [] }, NOW, when, copy);
    expect(parts).toEqual({ label: "连载中", when: null, detail: null, live: true });
    expect(statusText(parts)).toBe("连载中");
  });

  test("finished, with the episode total", () => {
    const parts = heroStatusParts({ status: "FINISHED", statusLabel: "已完结", episodes: 12, airings: [] }, NOW, when, copy);
    expect(statusText(parts)).toBe("已完结 · 共 12 集");
    expect(parts.live).toBe(false);
  });

  test("finished, total unknown", () => {
    const parts = heroStatusParts({ status: "FINISHED", statusLabel: "已完结", episodes: 0, airings: [] }, NOW, when, copy);
    expect(statusText(parts)).toBe("已完结");
  });

  test("not yet aired but scheduled", () => {
    const parts = heroStatusParts(
      { status: "NOT_YET_RELEASED", statusLabel: "未开播", episodes: null, airings: [{ at: NOW + 5, ep: 1 }] },
      NOW,
      when,
      copy,
    );
    expect(statusText(parts)).toBe(`未开播 · T${NOW + 5} 更新第 1 集`);
    expect(parts.live).toBe(false);
  });

  test("an airing that has already passed is not presented as upcoming", () => {
    const parts = heroStatusParts(
      { status: "RELEASING", statusLabel: "连载中", episodes: 12, airings: [{ at: NOW - 1, ep: 12 }] },
      NOW,
      when,
      copy,
    );
    expect(statusText(parts)).toBe("连载中");
  });

  test("an unknown status renders nothing rather than a raw enum", () => {
    const parts = heroStatusParts({ status: null, statusLabel: "", episodes: 12, airings: [] }, NOW, when, copy);
    expect(statusText(parts)).toBe("");
  });
});

describe("statusText short form", () => {
  test("drops the episode detail when there is a time, for narrow screens", () => {
    const parts = { label: "连载中", when: "周日 19:00", detail: "更新第 14 集", live: true };
    expect(statusText(parts, { short: true })).toBe("连载中 · 周日 19:00");
  });

  test("keeps a detail that has no time to replace it", () => {
    const parts = { label: "已完结", when: null, detail: "共 12 集", live: false };
    expect(statusText(parts, { short: true })).toBe("已完结 · 共 12 集");
  });
});
