// The invariant under test is one sentence: an automatic match may never
// overwrite a binding the user set by hand. Everything else here is the
// scaffolding that keeps that sentence true.
//
// bun test has no fake-indexeddb, so nothing here touches Dexie. The policy
// lives in `decideBindingWrite` (pure), and `readBinding` / `writeBinding` are
// exercised against a hand-rolled table double — which also proves the module
// only depends on the four table methods it declares.

import { describe, it, expect } from "vitest";
import {
  decideBindingWrite,
  isBindingLocked,
  onBindingChanged,
  readBinding,
  writeBinding,
  type BindableSeries,
  type BindingDb,
  type BindingOverride,
} from "./animeBinding";

interface FakeState {
  series: Map<string, BindableSeries & { id: string; updatedAt?: number }>;
  overrides: Map<string, BindingOverride & { seriesId: string }>;
  seriesUpdates: Record<string, unknown>[];
}

function makeDb(
  init: {
    series?: (BindableSeries & { id: string; updatedAt?: number })[];
    overrides?: (BindingOverride & { seriesId: string })[];
    withOverrideTable?: boolean;
  } = {},
): { db: BindingDb; state: FakeState } {
  const state: FakeState = {
    series: new Map((init.series ?? []).map((s) => [s.id, s])),
    overrides: new Map((init.overrides ?? []).map((o) => [o.seriesId, o])),
    seriesUpdates: [],
  };

  const db: BindingDb = {
    series: {
      async get(id) {
        return state.series.get(id);
      },
      async update(id, changes) {
        state.seriesUpdates.push({ id, ...changes });
        const prev = state.series.get(id);
        if (prev) state.series.set(id, { ...prev, ...changes });
        return 1;
      },
    },
    userOverride:
      init.withOverrideTable === false
        ? null
        : {
            async get(id) {
              return state.overrides.get(id);
            },
            async put(row) {
              const seriesId = String(row.seriesId);
              state.overrides.set(seriesId, {
                ...(row as unknown as BindingOverride),
                seriesId,
              });
              return seriesId;
            },
          },
  };

  return { db, state };
}

describe("decideBindingWrite — 策略", () => {
  it("auto 在未锁定时可以写", () => {
    const d = decideBindingWrite({
      series: { anilistId: undefined },
      override: null,
      nextAnilistId: 21,
      source: "auto",
    });
    expect(d).toEqual({
      writeSeries: true,
      lock: false,
      reason: "written",
      anilistId: 21,
    });
  });

  it("auto 在锁定时被拒 —— 这是整个模块存在的理由", () => {
    const d = decideBindingWrite({
      series: { anilistId: 999 },
      override: { locked: true },
      nextAnilistId: 21,
      source: "auto",
    });
    expect(d.writeSeries).toBe(false);
    expect(d.reason).toBe("locked");
    // 报回来的是「仍然生效的那个 id」,不是被拒的那个 —— 调用方通常要拿它渲染。
    expect(d.anilistId).toBe(999);
  });

  it("auto 被拒时不静默 —— reason 明确到可以打日志", () => {
    const d = decideBindingWrite({
      series: { anilistId: 999 },
      override: { locked: true },
      nextAnilistId: 21,
      source: "auto",
    });
    expect(["locked"]).toContain(d.reason);
  });

  it("manual 总是可写,并置 locked", () => {
    const d = decideBindingWrite({
      series: { anilistId: 999 },
      override: null,
      nextAnilistId: 21,
      source: "manual",
    });
    expect(d).toEqual({
      writeSeries: true,
      lock: true,
      reason: "written",
      anilistId: 21,
    });
  });

  it("manual 可以覆盖另一次 manual", () => {
    const d = decideBindingWrite({
      series: { anilistId: 100 },
      override: { locked: true },
      nextAnilistId: 200,
      source: "manual",
    });
    expect(d.writeSeries).toBe(true);
    expect(d.anilistId).toBe(200);
  });

  it("manual 重选同一个 id,但行还没锁 → 只补锁", () => {
    const d = decideBindingWrite({
      series: { anilistId: 21 },
      override: { locked: false },
      nextAnilistId: 21,
      source: "manual",
    });
    expect(d.writeSeries).toBe(false);
    expect(d.lock).toBe(true);
    expect(d.reason).toBe("written");
  });

  it("id 没变就不写 —— db.series 上挂着 liveQuery,白写会重渲染整个网格", () => {
    const d = decideBindingWrite({
      series: { anilistId: 21 },
      override: null,
      nextAnilistId: 21,
      source: "auto",
    });
    expect(d.writeSeries).toBe(false);
    expect(d.reason).toBe("unchanged");
  });

  it("非正整数 id 一律拒写", () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, "", "abc", {}]) {
      const d = decideBindingWrite({
        series: { anilistId: 7 },
        override: null,
        nextAnilistId: bad,
        source: "manual",
      });
      expect(d.writeSeries).toBe(false);
      expect(d.reason).toBe("invalid-id");
    }
  });

  it("数字字符串收窄成 id —— 外部输入来自 JSON,不能假设已经是 number", () => {
    const d = decideBindingWrite({
      series: {},
      override: null,
      nextAnilistId: "21",
      source: "auto",
    });
    expect(d.writeSeries).toBe(true);
    expect(d.anilistId).toBe(21);
  });

  it("series 不存在时不写", () => {
    const d = decideBindingWrite({
      series: null,
      override: null,
      nextAnilistId: 21,
      source: "manual",
    });
    expect(d.writeSeries).toBe(false);
    expect(d.reason).toBe("missing-series");
  });
});

describe("isBindingLocked", () => {
  it("只有显式 true 才算锁 —— undefined / 缺行都是未锁", () => {
    expect(isBindingLocked({ locked: true })).toBe(true);
    expect(isBindingLocked({ locked: false })).toBe(false);
    expect(isBindingLocked({})).toBe(false);
    expect(isBindingLocked(null)).toBe(false);
    expect(isBindingLocked(undefined)).toBe(false);
  });
});

describe("readBinding", () => {
  it("无绑定返回 null", async () => {
    const { db } = makeDb({ series: [{ id: "s1" }] });
    expect(await readBinding(db, "s1")).toBeNull();
  });

  it("series 不存在返回 null", async () => {
    const { db } = makeDb();
    expect(await readBinding(db, "nope")).toBeNull();
  });

  it("seriesId 为空返回 null,不去查库", async () => {
    const { db } = makeDb();
    expect(await readBinding(db, "")).toBeNull();
  });

  it("未锁定 → source=auto", async () => {
    const { db } = makeDb({ series: [{ id: "s1", anilistId: 21 }] });
    expect(await readBinding(db, "s1")).toEqual({
      anilistId: 21,
      source: "auto",
    });
  });

  it("锁定 → source=manual", async () => {
    const { db } = makeDb({
      series: [{ id: "s1", anilistId: 21 }],
      overrides: [{ seriesId: "s1", locked: true }],
    });
    expect(await readBinding(db, "s1")).toEqual({
      anilistId: 21,
      source: "manual",
    });
  });

  it("脏 id(0 / 负数)当作无绑定,不往下游传", async () => {
    const { db } = makeDb({ series: [{ id: "s1", anilistId: 0 }] });
    expect(await readBinding(db, "s1")).toBeNull();
  });

  it("v5 形状的库(没有 userOverride 表)降级为 auto,不抛", async () => {
    const { db } = makeDb({
      series: [{ id: "s1", anilistId: 21 }],
      withOverrideTable: false,
    });
    expect(await readBinding(db, "s1")).toEqual({
      anilistId: 21,
      source: "auto",
    });
  });
});

describe("writeBinding", () => {
  it("auto 写入后读得回来", async () => {
    const { db, state } = makeDb({ series: [{ id: "s1" }] });
    const res = await writeBinding(db, "s1", 21, "auto");
    expect(res).toEqual({ written: true, reason: "written", anilistId: 21 });
    expect(await readBinding(db, "s1")).toEqual({
      anilistId: 21,
      source: "auto",
    });
    expect(state.overrides.size).toBe(0);
  });

  it("auto 撞上 locked → 拒写,库里的 id 一个字节不动", async () => {
    const { db, state } = makeDb({
      series: [{ id: "s1", anilistId: 999 }],
      overrides: [{ seriesId: "s1", locked: true }],
    });
    const res = await writeBinding(db, "s1", 21, "auto");
    expect(res).toEqual({ written: false, reason: "locked", anilistId: 999 });
    expect(state.seriesUpdates).toEqual([]);
    expect(state.series.get("s1")?.anilistId).toBe(999);
  });

  it("manual 写入并置 locked,此后 auto 再也覆盖不了", async () => {
    const { db, state } = makeDb({ series: [{ id: "s1", anilistId: 999 }] });

    const manual = await writeBinding(db, "s1", 21, "manual");
    expect(manual.written).toBe(true);
    expect(state.overrides.get("s1")?.locked).toBe(true);

    const auto = await writeBinding(db, "s1", 555, "auto");
    expect(auto.reason).toBe("locked");
    expect(await readBinding(db, "s1")).toEqual({
      anilistId: 21,
      source: "manual",
    });
  });

  it("manual 保留 override 上的其他字段 —— 别把合并/拆分历史顺手抹了", async () => {
    const { db, state } = makeDb({
      series: [{ id: "s1" }],
      overrides: [
        {
          seriesId: "s1",
          mergedFrom: ["s2"],
          overrideSeasonAnimeId: 4242,
        } as BindingOverride & {
          seriesId: string;
          mergedFrom: string[];
          overrideSeasonAnimeId: number;
        },
      ],
    });
    await writeBinding(db, "s1", 21, "manual");
    const row = state.overrides.get("s1") as unknown as Record<string, unknown>;
    expect(row.mergedFrom).toEqual(["s2"]);
    expect(row.overrideSeasonAnimeId).toBe(4242);
    expect(row.locked).toBe(true);
  });

  it("id 没变就不产生写操作", async () => {
    const { db, state } = makeDb({ series: [{ id: "s1", anilistId: 21 }] });
    const res = await writeBinding(db, "s1", 21, "auto");
    expect(res).toEqual({ written: false, reason: "unchanged", anilistId: 21 });
    expect(state.seriesUpdates).toEqual([]);
  });

  it("从不改 updatedAt —— 「最近新增」按它排序,解析 id 不是用户新增了什么", async () => {
    const { db, state } = makeDb({
      series: [{ id: "s1", updatedAt: 1000 }],
    });
    await writeBinding(db, "s1", 21, "auto");
    expect(state.seriesUpdates).toEqual([{ id: "s1", anilistId: 21 }]);
    expect(state.series.get("s1")?.updatedAt).toBe(1000);
  });

  it("非法 id 拒写并给出理由", async () => {
    const { db, state } = makeDb({ series: [{ id: "s1" }] });
    const res = await writeBinding(db, "s1", "not-an-id", "manual");
    expect(res.written).toBe(false);
    expect(res.reason).toBe("invalid-id");
    expect(state.seriesUpdates).toEqual([]);
  });

  it("series 不存在时拒写", async () => {
    const { db, state } = makeDb();
    const res = await writeBinding(db, "ghost", 21, "manual");
    expect(res.reason).toBe("missing-series");
    expect(state.seriesUpdates).toEqual([]);
  });

  it("seriesId 为空时拒写", async () => {
    const { db } = makeDb();
    expect((await writeBinding(db, "", 21, "manual")).reason).toBe(
      "missing-series",
    );
  });
});

describe("onBindingChanged", () => {
  it("写成功才通知,拒写不通知", async () => {
    const seen: string[] = [];
    const off = onBindingChanged((id) => seen.push(id));
    try {
      const { db } = makeDb({
        series: [
          { id: "s1" },
          { id: "s2", anilistId: 999 },
        ],
        overrides: [{ seriesId: "s2", locked: true }],
      });
      await writeBinding(db, "s1", 21, "auto");
      await writeBinding(db, "s2", 21, "auto"); // locked → 拒
      await writeBinding(db, "s1", 21, "auto"); // unchanged → 不写
      expect(seen).toEqual(["s1"]);
    } finally {
      off();
    }
  });

  it("取消订阅后不再收到", async () => {
    const seen: string[] = [];
    onBindingChanged((id) => seen.push(id))();
    const { db } = makeDb({ series: [{ id: "s1" }] });
    await writeBinding(db, "s1", 21, "auto");
    expect(seen).toEqual([]);
  });

  it("一个监听器抛错不影响已经落库的写和其他监听器", async () => {
    const seen: string[] = [];
    const offBad = onBindingChanged(() => {
      throw new Error("cache blew up");
    });
    const offGood = onBindingChanged((id) => seen.push(id));
    try {
      const { db } = makeDb({ series: [{ id: "s1" }] });
      const res = await writeBinding(db, "s1", 21, "auto");
      expect(res.written).toBe(true);
      expect(seen).toEqual(["s1"]);
    } finally {
      offBad();
      offGood();
    }
  });
});
