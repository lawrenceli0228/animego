// The user detail drawer, mounted in a real DOM: the words a failed action is
// reported in. Runs in its own bun process (domSuites.test.ts), which is what
// lets it stub the server actions module.
//
// Every fixture is synthetic.

import { button, click, holdFetch, mount, settle, type, unmountAll } from "@/lib/test-utils/domHarness";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { UserDrawerMode, UserDrawerTarget } from "@/lib/adminUsers";
import type { AdminUserDetail, AdminUserSession } from "../_types/users";

// ─── The server actions, answered by the test ───────────────────────────

interface ActionCall {
  name: string;
  args: unknown[];
  resolve: (value: unknown) => Promise<void>;
  reject: (err: unknown) => Promise<void>;
}

const actionCalls: ActionCall[] = [];

function held(name: string) {
  return (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      actionCalls.push({
        name,
        args,
        resolve: async (value) => {
          resolve(value);
          await settle();
        },
        reject: async (err) => {
          reject(err);
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

const { default: UserDetailDrawer } = await import("./UserDetailDrawer");

// ─── Fixtures ──────────────────────────────────────────────────────────

const TODAY = "2030-06-12";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const PHONE = "00000000-0000-4000-8000-0000000000b1";
const LAPTOP = "00000000-0000-4000-8000-0000000000b2";

function session(id: string, os: string, browser: string): AdminUserSession {
  return {
    id,
    kind: "phone",
    os,
    browser,
    country: null,
    createdAt: "2030-06-01T02:00:00Z",
    lastUsedAt: "2030-06-11T02:00:00Z",
    expiresAt: "2030-07-01T02:00:00Z",
  };
}

function detail(sessions: AdminUserSession[] = [session(PHONE, "Android", "Chrome"), session(LAPTOP, "Windows", "Edge")]): AdminUserDetail {
  return {
    today: TODAY,
    instrumentedSince: "2030-01-01",
    user: {
      _id: USER_ID,
      username: "fixture-a",
      email: "a@example.test",
      role: null,
      createdAt: "2030-01-05T01:00:00Z",
      isPublic: false,
      avatarUrl: null,
    },
    activity: {
      activeDays: 3,
      recordedDays: 3,
      lastSeenAt: "2030-06-11T02:00:00Z",
      logins: 1,
      requests: 9,
      days90: [{ date: "2030-06-11", recorded: true }],
    },
    subscriptions: { total: 0, watching: 0, completed: 0, planToWatch: 0, dropped: 0, rated: 0, avgScore: null, lastUpdatedAt: null },
    watches: { total: 0, lastWatchedAt: null },
    recentWatches: [],
    recentSubscriptions: [],
    sessions,
    community: { comments: 0, replies: 0, threads: 0, reviews: 0, danmaku: 0, following: 0, followers: 0, reportsFiled: 0, editSubmissions: 0 },
  };
}

function target(mode: UserDrawerMode = "view"): UserDrawerTarget {
  return { id: USER_ID, username: "fixture-a", email: "a@example.test", role: null, createdAt: "2030-01-05T01:00:00Z", mode };
}

// ─── Mounting ──────────────────────────────────────────────────────────

let net: ReturnType<typeof holdFetch>;
const onRestoreFocus = mock(() => {});
const onClose = mock(() => {});
const onChanged = mock(() => {});
const onDeleted = mock((...ids: unknown[]) => ids);

beforeEach(() => {
  actionCalls.length = 0;
  for (const fn of [onRestoreFocus, onClose, onChanged, onDeleted]) fn.mockClear();
  net = holdFetch();
});

afterEach(async () => {
  await unmountAll();
  net.restore();
});

/** Opens the drawer and answers its read with `body` (a detail, or an error status). */
async function open(mode: UserDrawerMode = "view", answer: { body: unknown; status?: number } = { body: { data: detail() } }) {
  await mount(
    <UserDetailDrawer
      target={target(mode)}
      onRestoreFocus={onRestoreFocus}
      onClose={onClose}
      onChanged={onChanged}
      onDeleted={onDeleted}
    />,
  );
  await net.requests[0].respond(answer.body, answer.status);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("no dialog");
  return dialog;
}

// ─── What a failed action says ─────────────────────────────────────────

describe("a failed action is reported in the drawer's own words", () => {
  async function rename() {
    const dialog = await open("edit");
    const name = dialog.querySelector<HTMLInputElement>('[data-form="edit"] input');
    if (!name) throw new Error("no username field");
    await type(name, "fixture-taken");
    await click(button(dialog, "保存"));
    return dialog;
  }

  test("a username go-api says is taken", async () => {
    const dialog = await rename();

    await actionCalls[0].resolve({ ok: false, status: 409, code: "CONFLICT", message: "Username already exists" });

    const alert = dialog.querySelector('[data-block="actions"] [role="alert"]');
    expect(alert?.textContent).toBe("这个用户名已被占用");
    expect(dialog.querySelector('[data-form="edit"]')).not.toBeNull();
  });

  test("an action that throws — production replaces its message with React's — says the action failed", async () => {
    const dialog = await rename();

    await actionCalls[0].reject(new Error("An error occurred in the Server Components render."));

    const alert = dialog.querySelector('[data-block="actions"] [role="alert"]');
    expect(alert?.textContent).toBe("更新失败");
  });

  test("signing out a device that is already gone", async () => {
    const dialog = await open();
    await click(dialog.querySelector(`[data-session="${PHONE}"] button`));

    await actionCalls[0].resolve({ ok: false, status: 404, code: "NOT_FOUND", message: "Session not found" });

    const alert = dialog.querySelector('[data-block="sessions"] [role="alert"]');
    expect(alert?.textContent).toBe("这台设备已经退出了");
  });
});
