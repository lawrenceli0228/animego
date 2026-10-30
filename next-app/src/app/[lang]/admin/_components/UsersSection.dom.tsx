// The user list, mounted in a real DOM with a fetch the test answers by hand:
// what the table, the chips and the search box show while a request is out,
// after one is superseded, and after one fails. renderToStaticMarkup runs no
// effects, so none of this can be seen from UsersSection.render.test.tsx.
// Runs in its own bun process (domSuites.test.ts).
//
// Every fixture is synthetic.

import { button, click, holdFetch, mount, settle, type, unmountAll } from "@/lib/test-utils/domHarness";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdminUserRow, AdminUsersPage } from "../_types/users";

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

  test("puts the search box back too, unless something newer was typed", async () => {
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
