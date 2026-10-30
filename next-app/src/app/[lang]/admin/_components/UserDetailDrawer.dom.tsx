// The user detail drawer, mounted in a real DOM: where focus goes when part
// of it disappears, the keys it answers wherever focus is, and the words a
// failed action is reported in. Runs in its own bun process (domSuites.test.ts),
// which is what lets it stub the server actions module.
//
// Every fixture is synthetic.

import {
  button,
  click,
  describeFocus,
  holdFetch,
  mount,
  press,
  settle,
  type,
  unmountAll,
} from "@/lib/test-utils/domHarness";

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

// The toasts the drawer raises, as [kind, text].
const toasts: Array<[string, string]> = [];
mock.module("react-hot-toast", () => {
  const toast = Object.assign((text: string) => toasts.push(["blank", text]), {
    success: (text: string) => toasts.push(["success", text]),
    error: (text: string) => toasts.push(["error", text]),
  });
  return { toast, default: toast, Toaster: () => null };
});

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
  toasts.length = 0;
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

const inside = (dialog: HTMLElement) => dialog.contains(document.activeElement);

// ─── Focus ─────────────────────────────────────────────────────────────

describe("focus stays in the drawer when part of it goes away", () => {
  test("取消 in a confirmation hands focus back to the button that opened it", async () => {
    const dialog = await open("revokeAll");
    expect(describeFocus()).toBe("<button> 取消");

    await click(button(dialog, "取消"));

    expect(dialog.querySelector("[data-confirm]")).toBeNull();
    expect(describeFocus()).toBe("<button> 退出全部设备");
  });

  test("so Escape still closes the drawer afterwards", async () => {
    const dialog = await open("delete");
    await click(button(dialog, "取消"));

    await press("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a successful 全部退出 closes its confirmation onto 退出全部设备", async () => {
    const dialog = await open("revokeAll");
    await click(button(dialog, "全部退出"));
    expect(actionCalls.map((c) => c.name)).toEqual(["revokeAdminUserSessions"]);

    await actionCalls[0].resolve({ ok: true, data: { revoked: 2 } });

    expect(dialog.querySelector("[data-confirm]")).toBeNull();
    expect(describeFocus()).toBe("<button> 退出全部设备");
  });

  test("a saved profile closes its form onto 编辑资料", async () => {
    const dialog = await open("edit");
    const name = dialog.querySelector<HTMLInputElement>('[data-form="edit"] input');
    if (!name) throw new Error("no username field");
    await type(name, "fixture-renamed");
    await click(button(dialog, "保存"));

    await actionCalls[0].resolve({
      ok: true,
      data: { _id: USER_ID, username: "fixture-renamed", email: "a@example.test", role: null, createdAt: "2030-01-05T01:00:00Z" },
    });

    expect(dialog.querySelector('[data-form="edit"]')).toBeNull();
    expect(describeFocus()).toBe("<button> 编辑资料");
  });

  test("a signed-out device's row goes, and focus moves to the next device", async () => {
    const dialog = await open();
    const phone = dialog.querySelector<HTMLElement>(`[data-session="${PHONE}"] button`);
    phone?.focus();
    await click(phone);
    await actionCalls[0].resolve({ ok: true, data: { revoked: 1 } });
    // The drawer reads the account again; this time the phone is gone.
    await net.requests[1].respond({ data: detail([session(LAPTOP, "Windows", "Edge")]) });

    expect(dialog.querySelector(`[data-session="${PHONE}"]`)).toBeNull();
    expect(describeFocus()).toBe("<button> 退出这台设备：Windows · Edge");
  });

  test("the last device's row goes, and focus moves to the device list's heading", async () => {
    const dialog = await open("view", { body: { data: detail([session(PHONE, "Android", "Chrome")]) } });
    const phone = dialog.querySelector<HTMLElement>(`[data-session="${PHONE}"] button`);
    phone?.focus();
    await click(phone);
    await actionCalls[0].resolve({ ok: true, data: { revoked: 1 } });
    await net.requests[1].respond({ data: detail([]) });

    expect(inside(dialog)).toBe(true);
    expect(document.activeElement?.closest('[data-block="sessions"]')).not.toBeNull();
  });

  test("重试 after a failed read keeps focus in the drawer", async () => {
    const dialog = await open("view", { body: { error: { code: "SERVER_ERROR", message: "boom" } }, status: 500 });
    const retry = button(dialog, "重试");
    retry.focus();

    await click(retry);

    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(inside(dialog)).toBe(true);
  });
});

describe("Escape and Tab work wherever focus is", () => {
  test("Escape with focus on <body> closes the drawer", async () => {
    await open();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(describeFocus()).toBe("<body>");

    await press("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape while an input method is composing is left to it", async () => {
    const dialog = await open("edit");
    expect(inside(dialog)).toBe(true);

    await press("Escape", { isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  test("so is Safari's, which has ended the composition but still sends key code 229", async () => {
    await open("edit");

    await press("Escape", { keyCode: 229 } as KeyboardEventInit);

    expect(onClose).not.toHaveBeenCalled();
  });

  test("Tab from outside the drawer enters it at the first control, Shift+Tab at the last", async () => {
    const dialog = await open();
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    (document.activeElement as HTMLElement | null)?.blur();

    const forward = await press("Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);

    (document.activeElement as HTMLElement | null)?.blur();
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  test("Tab wraps from the last control to the first and back", async () => {
    const dialog = await open();
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    controls[controls.length - 1].focus();

    await press("Tab");
    expect(document.activeElement).toBe(controls[0]);

    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  test("opening puts focus in the drawer and closing hands it back once", async () => {
    const dialog = await open();
    expect(inside(dialog)).toBe(true);

    await unmountAll();

    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });
});

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

  test("a delete reports the deleted account's id", async () => {
    const dialog = await open("delete");
    await click(button(dialog, "确认删除"));

    await actionCalls[0].resolve({ ok: true, data: { deleted: true, username: "fixture-a" } });

    expect(onDeleted.mock.calls).toEqual([[USER_ID]]);
  });

  test("one that fails after the drawer was closed is a toast, in the drawer's words", async () => {
    const dialog = await open("delete");
    await click(button(dialog, "确认删除"));
    // Escape or the backdrop: the drawer goes while the delete is out.
    await unmountAll();

    await actionCalls[0].resolve({ ok: false, status: 400, code: "BAD_REQUEST", message: "Cannot delete yourself" });

    expect(toasts).toEqual([["error", "不能删除你自己的账号"]]);
  });
});
