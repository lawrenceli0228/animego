// The user list, mounted in a real DOM with a fetch the test answers by hand:
// what the table, the chips and the search box show while a request is out,
// after one is superseded, and after one fails — and the drawer a late delete
// must not close. renderToStaticMarkup runs no effects, so none of this can be
// seen from UsersSection.render.test.tsx. Runs in its own bun process
// (domSuites.test.ts).
//
// Every fixture is synthetic.

import { button, click, holdFetch, mount, press, settle, type, unmountAll } from "@/lib/test-utils/domHarness";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdminUserDetail, AdminUserRow, AdminUsersPage } from "../_types/users";

// ─── The server actions, answered by the test ───────────────────────────

interface ActionCall {
  name: string;
  args: unknown[];
  resolve: (value: unknown) => Promise<void>;
}

const actionCalls: ActionCall[] = [];

function held(name: string) {
  return (...args: unknown[]) =>
    new Promise((resolve) => {
      actionCalls.push({
        name,
        args,
        resolve: async (value) => {
          resolve(value);
          await settle();
        },
      });
    });
}

mock.module("../_actions/users", () => ({
  createAdminUser: held("createAdminUser"),
  updateAdminUser: held("updateAdminUser"),
  setAdminUserPassword: held("setAdminUserPassword"),
  deleteAdminUser: held("deleteAdminUser"),
  revokeAdminUserSessions: held("revokeAdminUserSessions"),
  revokeAdminUserSession: held("revokeAdminUserSession"),
}));

const { UsersSection } = await import("./UsersSection");

// ─── Fixtures ──────────────────────────────────────────────────────────

const TODAY = "2030-06-12";
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";

function row(id: string, username: string, role: string | null = null): AdminUserRow {
  return {
    _id: id,
    username,
    email: `${username}@example.test`,
    role,
    createdAt: "2030-01-05T01:00:00Z",
    lastSeenAt: "2030-06-11T02:00:00Z",
    activeDays: 3,
    logins: 1,
    subscriptions: 2,
    followers: 0,
    ratings: 0,
    watchedEpisodes: 4,
    returned: true,
    recentActiveDates: ["2030-06-11"],
    lastDevice: null,
  };
}

const EVERYONE = [row(A, "fixture-a"), row(B, "fixture-b")];

function page(rows: AdminUserRow[] = EVERYONE): AdminUsersPage {
  return {
    data: rows,
    hasMore: false,
    total: rows.length,
    page: 1,
    today: TODAY,
    segments: { all: 3, active7: 2, returned: 2, neverReturned: 1, subscribed: 2, admin: 1 },
  };
}

function detail(id: string, username: string): AdminUserDetail {
  return {
    today: TODAY,
    instrumentedSince: "2030-01-01",
    user: { _id: id, username, email: `${username}@example.test`, role: null, createdAt: "2030-01-05T01:00:00Z", isPublic: false, avatarUrl: null },
    activity: { activeDays: 3, recordedDays: 3, lastSeenAt: null, logins: 1, requests: 9, days90: [] },
    subscriptions: { total: 0, watching: 0, completed: 0, planToWatch: 0, dropped: 0, rated: 0, avgScore: null, lastUpdatedAt: null },
    watches: { total: 0, lastWatchedAt: null },
    recentWatches: [],
    recentSubscriptions: [],
    sessions: [],
    community: { comments: 0, replies: 0, threads: 0, reviews: 0, danmaku: 0, following: 0, followers: 0, reportsFiled: 0, editSubmissions: 0 },
  };
}

const FAILED = { error: { code: "SERVER_ERROR", message: "boom" } };

// ─── Reading the section ───────────────────────────────────────────────

let net: ReturnType<typeof holdFetch>;
let host: HTMLElement;

beforeEach(async () => {
  actionCalls.length = 0;
  net = holdFetch();
  host = await mount(<UsersSection initial={page()} />);
});

afterEach(async () => {
  await unmountAll();
  net.restore();
});

const table = () => host.querySelector("table")?.parentElement ?? null;
const busy = () => table()?.getAttribute("aria-busy") ?? null;
const pressed = () => host.querySelector('[data-segment][aria-pressed="true"]')?.getAttribute("data-segment");
const rows = () => Array.from(host.querySelectorAll("tr[data-user-row]")).map((tr) => tr.getAttribute("data-user-row"));
const alert = () => host.querySelector('#users > [role="alert"]')?.textContent ?? null;
const chip = (segment: string) => host.querySelector(`[data-segment="${segment}"]`);
const lastRequest = () => net.requests[net.requests.length - 1];

/**
 * Waits for the drawer to be in the document. next/dynamic loads its module
 * on the first open, which a cold CI runner can take a while to transpile.
 */
async function drawerFor(id: string): Promise<HTMLElement> {
  for (let waited = 0; waited < 10_000; waited += 10) {
    const found = document.querySelector<HTMLElement>(`[data-user-drawer="${id}"]`);
    if (found) return found;
    await settle(10);
  }
  throw new Error(`no drawer for ${id}`);
}

// ─── Loading ───────────────────────────────────────────────────────────

describe("a request that is superseded leaves nothing loading", () => {
  test("管理员, then straight back to 全部 before it answers", async () => {
    await click(chip("admin"));
    expect(busy()).toBe("true");

    await click(chip("all"));
    await settle();

    expect(net.requests.map((r) => [r.url, r.aborted])).toEqual([["/api/admin/users?page=1&segment=admin", true]]);
    expect(busy()).toBeNull();
    expect(pressed()).toBe("all");
    expect(rows()).toEqual([A, B]);
  });

  test("a search typed and cleared before it answers", async () => {
    const box = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!box) throw new Error("no search box");
    await type(box, "fixture");
    await settle(450);
    expect(lastRequest()?.url).toBe("/api/admin/users?page=1&q=fixture");
    expect(busy()).toBe("true");

    await type(box, "");
    await settle(450);

    expect(lastRequest()?.aborted).toBe(true);
    expect(busy()).toBeNull();
  });

  test("an older answer never replaces a newer query's rows", async () => {
    await click(chip("admin"));
    await click(chip("returned"));
    expect(net.requests.map((r) => r.aborted)).toEqual([true, false]);

    await lastRequest().respond(page([row(C, "fixture-c")]));

    expect(rows()).toEqual([C]);
    expect(pressed()).toBe("returned");
    expect(busy()).toBeNull();
  });
});

// ─── Failure ───────────────────────────────────────────────────────────

describe("a failed request", () => {
  test("puts the chips back on the rows still shown, and says the list could not be read", async () => {
    await click(chip("admin"));

    await lastRequest().respond(FAILED, 500);

    expect(pressed()).toBe("all");
    expect(rows()).toEqual([A, B]);
    expect(alert()).toContain("用户列表读取失败");
    expect(busy()).toBeNull();
  });

  test("puts the search box back too", async () => {
    const box = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!box) throw new Error("no search box");
    await type(box, "fixture");
    await settle(450);

    await lastRequest().respond(FAILED, 500);
    await settle(450);

    expect(box.value).toBe("");
    // Nothing re-sent the failed search on its own.
    expect(net.requests).toHaveLength(1);
  });

  test("but not over a search typed since, which is asked for next", async () => {
    const box = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!box) throw new Error("no search box");
    await type(box, "fixture");
    await settle(450);
    await type(box, "fixture2");

    await lastRequest().respond(FAILED, 500);
    expect(box.value).toBe("fixture2");
    await settle(450);

    expect(lastRequest().url).toBe("/api/admin/users?page=1&q=fixture2");
  });

  test("重试 moves focus to the list's heading before its own button goes", async () => {
    await click(chip("admin"));
    await lastRequest().respond(FAILED, 500);
    const retry = button(host, "重试");
    retry.focus();

    await click(retry);

    expect(alert()).toBeNull();
    expect(document.activeElement?.id).toBe("users-heading");
  });

  test("重试 asks for the failed query again, and its chip comes back with it", async () => {
    await click(chip("admin"));
    await lastRequest().respond(FAILED, 500);

    await click(button(host, "重试"));

    expect(lastRequest().url).toBe("/api/admin/users?page=1&segment=admin");
    expect(pressed()).toBe("admin");
    await lastRequest().respond(page([row(C, "fixture-admin", "admin")]));
    expect(rows()).toEqual([C]);
    expect(alert()).toBeNull();
  });

  test("is still reported after a switch away and back that never answered", async () => {
    await click(chip("admin"));
    await lastRequest().respond(FAILED, 500);

    await click(chip("returned"));
    await click(chip("all"));
    await settle();

    expect(alert()).toContain("用户列表读取失败");
    expect(busy()).toBeNull();
  });
});

describe("a first page the server could not read", () => {
  test("the browser's own try says it is loading, and its failure says so", async () => {
    await unmountAll();
    host = await mount(<UsersSection initial={null} />);
    const status = () => host.querySelector('[role="status"]')?.textContent ?? null;

    expect(lastRequest().url).toBe("/api/admin/users?page=1");
    expect(status()).toBe("加载中…");
    expect(alert()).toBeNull();

    await lastRequest().respond(FAILED, 500);

    expect(status()).toBeNull();
    expect(alert()).toContain("用户列表读取失败");
  });
});

// ─── The drawer ────────────────────────────────────────────────────────

describe("a delete that outlives its drawer", () => {
  test("does not close the drawer opened since, and the list still refetches", async () => {
    // A's drawer: ask for the delete, then close the drawer before it answers.
    await click(button(host.querySelector(`tr[data-user-row="${A}"]`) as HTMLElement, "fixture-a"));
    const drawerA = await drawerFor(A);
    await lastRequest().respond({ data: detail(A, "fixture-a") });
    await click(button(drawerA, "删除用户…"));
    await click(button(drawerA, "确认删除"));
    expect(actionCalls.map((c) => c.name)).toEqual(["deleteAdminUser"]);
    await press("Escape");
    expect(document.querySelector(`[data-user-drawer="${A}"]`)).toBeNull();

    // B's drawer is open when A's delete finishes.
    await click(button(host.querySelector(`tr[data-user-row="${B}"]`) as HTMLElement, "fixture-b"));
    await drawerFor(B);
    await lastRequest().respond({ data: detail(B, "fixture-b") });
    const before = net.requests.length;

    await actionCalls[0].resolve({ ok: true, data: { deleted: true, username: "fixture-a" } });

    expect(document.querySelector(`[data-user-drawer="${B}"]`)).not.toBeNull();
    expect(net.requests.slice(before).map((r) => r.url)).toEqual(["/api/admin/users?page=1"]);
  }, 30_000);
});
