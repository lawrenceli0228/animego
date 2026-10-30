import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { UserDrawerMode, UserDrawerTarget } from "@/lib/adminUsers";
import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import type { AdminUserDetail } from "../_types/users";
import { UserDetailPanel, type DetailStatus, type UserDetailPanelProps } from "./UserDetailPanel";

// The user detail drawer's contents, as server HTML (renderToStaticMarkup, no
// DOM): every block, every inline form and confirmation, and the states the
// fetch can leave it in. UserDetailDrawer — the portal, the focus trap, the
// fetch, the server actions and their toasts — needs a browser and is driven
// by e2e/specs/sandbox/admin.spec.ts; this pins what it draws.
//
// Every fixture is synthetic.

const TODAY = "2026-03-18";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "66666666-7777-4888-8999-000000000000";

const TARGET: UserDrawerTarget = {
  id: USER_ID,
  username: "fixture-reader",
  email: "reader@example.test",
  role: null,
  createdAt: "2025-12-01T12:13:00Z",
  mode: "view",
};

function detail(over: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    today: TODAY,
    instrumentedSince: "2026-01-20",
    user: {
      _id: USER_ID,
      username: "fixture-reader",
      email: "reader@example.test",
      role: null,
      createdAt: "2025-12-01T12:13:00Z",
      isPublic: true,
      avatarUrl: null,
    },
    activity: {
      activeDays: 42,
      recordedDays: 30,
      lastSeenAt: "2026-03-15T09:42:00Z",
      logins: 7,
      requests: 1234,
      days90: [
        { date: "2026-01-02", recorded: false },
        { date: "2026-01-10", recorded: false },
        { date: "2026-02-01", recorded: true },
        { date: "2026-03-01", recorded: true },
        { date: "2026-03-15", recorded: true },
      ],
    },
    subscriptions: {
      total: 64,
      watching: 12,
      completed: 40,
      planToWatch: 9,
      dropped: 3,
      rated: 21,
      avgScore: 8.42,
      lastUpdatedAt: "2026-03-10T03:00:00Z",
    },
    watches: { total: 321, lastWatchedAt: "2026-03-14T00:37:00Z" },
    recentWatches: [
      {
        anilistId: 900001,
        titleChinese: "测试番甲",
        titleRomaji: "Fixture Alpha",
        titleEnglish: "Fixture Alpha EN",
        titleNative: null,
        titleHant: null,
        episodes: 12,
        episode: 3,
        watchedAt: "2026-03-14T00:37:00Z",
      },
      {
        anilistId: 900002,
        titleChinese: null,
        titleRomaji: null,
        titleEnglish: null,
        titleNative: null,
        titleHant: null,
        episodes: null,
        episode: 7,
        watchedAt: "2026-03-13T12:14:00Z",
      },
    ],
    recentSubscriptions: [
      sub(900001, "测试番甲", "watching", 5, 12, null),
      sub(900003, "测试番乙", "completed", 12, 12, 9),
      sub(900004, "测试番丙", "plan_to_watch", 0, 24, null),
      sub(900005, "测试番丁", "dropped", 2, null, null),
    ],
    sessions: [
      {
        id: SESSION_ID,
        kind: "phone",
        os: "Android",
        browser: "Chrome",
        country: "CN",
        createdAt: "2026-03-01T12:31:00Z",
        lastUsedAt: "2026-03-15T09:26:00Z",
        expiresAt: "2026-04-01T12:31:00Z",
      },
    ],
    community: {
      comments: 5,
      replies: 4,
      threads: 3,
      reviews: 2,
      danmaku: 1,
      following: 6,
      followers: 11,
      reportsFiled: 0,
      editSubmissions: 8,
    },
    ...over,
  };
}

function sub(
  anilistId: number,
  titleChinese: string,
  status: string,
  currentEpisode: number,
  episodes: number | null,
  score: number | null,
) {
  return {
    anilistId,
    titleChinese,
    titleRomaji: null,
    titleEnglish: null,
    titleNative: null,
    titleHant: null,
    episodes,
    status,
    score,
    currentEpisode,
    updatedAt: "2026-03-10T03:00:00Z",
  };
}

const noop = () => {};

function props(over: Partial<UserDetailPanelProps> = {}): UserDetailPanelProps {
  return {
    titleId: "drawer-title",
    target: TARGET,
    detail: detail(),
    status: "ready",
    mode: "view",
    busy: false,
    actionError: null,
    deviceError: null,
    ending: new Set(),
    onClose: noop,
    onRetry: noop,
    onMode: noop,
    onSaveProfile: noop,
    onSavePassword: noop,
    onRevokeAll: noop,
    onRevokeSession: noop,
    onDelete: noop,
    ...over,
  };
}

function render(over: Partial<UserDetailPanelProps> = {}, lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <UserDetailPanel {...props(over)} />
    </LanguageProvider>,
  );
}

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** One block's markup, by its data-block name. */
function block(html: string, name: string): string {
  const start = html.indexOf(`data-block="${name}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf("data-block=", start + 12);
  return html.slice(start, next === -1 ? undefined : next);
}

afterEach(() => {
  setSystemTime();
});

describe("the header", () => {
  const html = render();

  test("name, email and tags, the name being the dialog's label", () => {
    expect(html).toContain('<h2 id="drawer-title"');
    expect(html).toMatch(/<h2 id="drawer-title"[^>]*>fixture-reader<\/h2>/);
    expect(text(block(html, "identity"))).toContain("reader@example.test");
    expect(text(block(html, "identity"))).toContain("普通用户");
    expect(text(block(html, "identity"))).toContain("主页公开");
  });

  test("registration in +08, the short id with the full one on hover, the zone said once", () => {
    const id = block(html, "identity");
    expect(text(id)).toContain("注册于 2025-12-01 20:13");
    expect(id).toContain(`title="${USER_ID}"`);
    expect(text(id)).toContain("用户 ID 11111111…");
    expect(text(id)).toContain("时间均为北京时间");
  });

  test("the close button is labelled with where it goes", () => {
    expect(html).toContain('aria-label="关闭，回到用户列表"');
    expect(text(html)).toContain("用户详情");
  });

  test("an admin is tagged as one; a private profile gets no tag", () => {
    const html2 = render({
      detail: detail({ user: { ...detail().user, role: "admin", isPublic: false } }),
    });
    expect(text(block(html2, "identity"))).toContain("管理员");
    expect(text(block(html2, "identity"))).not.toContain("主页公开");
  });
});

describe("the six tiles", () => {
  const tiles = (over: Partial<AdminUserDetail> = {}) => {
    const html = block(render({ detail: detail(over) }), "tiles");
    return Object.fromEntries(
      [...html.matchAll(/data-tile="(\w+)">(.*?)<\/div><\/div>/g)].map((m) => [m[1], text(m[2]).trim()]),
    );
  };

  test("each tile's value and the line that qualifies it", () => {
    const t = tiles();
    expect(t.activeDays).toBe("活跃天数 42 其中 30 天有逐请求记录");
    expect(t.lastSeen).toBe("最近活跃 3 天前 03-15 17:42");
    expect(t.logins).toBe("登录次数 7 只算输密码登录，自动续期不算");
    expect(t.subscriptions).toBe("追番 64 最近更新 03-10");
    expect(t.ratings).toBe("评分 21 平均 8.4 分");
    expect(t.watched).toBe("看过 321 集 最近 03-14 08:37");
  });

  test("nothing recorded, nothing rated, nothing watched — said, not zeroed into a date", () => {
    const t = tiles({
      activity: { ...detail().activity, lastSeenAt: null },
      subscriptions: { ...detail().subscriptions, rated: 0, avgScore: null, lastUpdatedAt: null },
      watches: { total: 0, lastWatchedAt: null },
    });
    expect(t.lastSeen).toBe("最近活跃 — 没有活跃记录");
    expect(t.ratings).toBe("评分 0 还没有评分");
    expect(t.watched).toBe("看过 0 集");
    expect(t.subscriptions).toBe("追番 64");
  });

  test("seen this morning reads 今天, on the +08 day", () => {
    // 23:30 UTC on the 17th is 07:30 on the 18th.
    const t = tiles({ activity: { ...detail().activity, lastSeenAt: "2026-03-17T23:30:00Z" } });
    expect(t.lastSeen).toBe("最近活跃 今天 03-18 07:30");
  });
});

describe("the 90-day calendar", () => {
  const html = block(render(), "calendar");

  test("Monday-first columns over the whole window, blanks outside it", () => {
    const cells = [...html.matchAll(/data-state="(\w+)"/g)].map((m) => m[1]);
    expect(cells).toHaveLength(14 * 7);
    // The window [12-19, 03-18] starts on a Friday and ends on a Wednesday.
    expect(cells.slice(0, 4)).toEqual(["outside", "outside", "outside", "outside"]);
    expect(cells.slice(-4)).toEqual(["outside", "outside", "outside", "outside"]);
  });

  test("recorded, reconstructed and no-visit days, today outlined", () => {
    expect(html.match(/data-state="recorded"/g)).toHaveLength(3);
    expect(html.match(/data-state="reconstructed"/g)).toHaveLength(2);
    expect(html.match(/data-today="true"/g)).toHaveLength(1);
    expect(decode(html)).toContain('title="1月2日 周五：有互动（1-20 开始记录前回推）"');
    expect(decode(html)).toContain('title="3月15日 周日：有访问"');
    expect(decode(html)).toContain('title="3月16日 周一：没有记录"');
  });

  test("one accessible summary, the legend, and the three counts", () => {
    expect(html).toContain('role="img" aria-label="近 90 天来过 5 天，其中 2 天是回推的"');
    expect(text(html)).toContain("1-20 开始记录前回推，只算有互动的天");
    expect(text(html)).toContain("有访问");
    expect(text(html)).toContain("没来");
    expect(html).toContain("近 30 天 <b>2</b> 天");
    expect(html).toContain("近 90 天 <b>5</b> 天");
    expect(html).toContain("累计 <b>42</b> 天");
  });

  test("month labels on the columns holding a 1st", () => {
    const months = [...html.matchAll(/<div>([^<]*)<\/div><span/g)].map((m) => m[1]).filter(Boolean);
    expect(months).toEqual(["12月", "1月", "2月", "3月"]);
  });

  test("no reconstructed day in the window, no reconstructed legend", () => {
    const only = block(
      render({ detail: detail({ activity: { ...detail().activity, days90: [{ date: TODAY, recorded: true }] } }) }),
      "calendar",
    );
    expect(text(only)).not.toContain("回推");
    expect(only).toContain('aria-label="近 90 天来过 1 天"');
  });
});

describe("devices, watches, subscriptions, community", () => {
  const html = render();

  test("each signed-in device, when it signed in, was used and expires, with its own sign-out", () => {
    const devices = block(html, "sessions");
    expect(text(devices)).toContain("登录设备 1 台");
    expect(text(devices)).toContain("Android · Chrome CN");
    expect(text(devices)).toContain("03-01 20:31 登录 · 最近使用 03-15 17:26 · 04-01 到期");
    expect(devices).toContain('aria-label="退出这台设备：Android · Chrome"');
    expect(devices).not.toContain('aria-disabled="true"');
  });

  test("a device being signed out is marked busy, not disabled", () => {
    const devices = block(render({ ending: new Set([SESSION_ID]) }), "sessions");
    expect(devices).toContain('aria-disabled="true"');
    expect(devices).toContain('aria-busy="true"');
    expect(devices).not.toContain("disabled=\"\"");
  });

  test("recent watches: time, title through pickTitle, episode of total", () => {
    const watches = text(block(html, "watches"));
    expect(watches).toContain("最近观看 共 321 集");
    expect(watches).toContain("03-14 08:37 测试番甲 第 3 集 / 12");
    // No title at all, no total: the id and the bare episode.
    expect(watches).toContain("03-13 20:14 #900002 第 7 集");
  });

  test("subscriptions: the status counts, each row's chip and progress, the public profile link", () => {
    const subs = block(html, "subscriptions");
    expect(text(subs)).toContain("追番 在看 12 · 看过 40 · 想看 9 · 弃番 3");
    expect(text(subs)).toContain("测试番甲 在看 看到 5 / 12");
    expect(text(subs)).toContain("测试番乙 看过 9 分");
    expect(text(subs)).toContain("测试番丙 想看 还没开始");
    expect(text(subs)).toContain("测试番丁 弃番 看到 2");
    expect(subs.match(/data-status="(\w+)"/g)).toEqual([
      'data-status="watching"',
      'data-status="completed"',
      'data-status="plan_to_watch"',
      'data-status="dropped"',
    ]);
    expect(subs).toContain('href="/u/fixture-reader"');
    expect(subs).toContain('target="_blank"');
    expect(subs).toContain('rel="noopener noreferrer"');
    expect(text(subs)).toContain("查看公开主页 →");
  });

  test("a private profile has no link to it", () => {
    const subs = block(render({ detail: detail({ user: { ...detail().user, isPublic: false } }) }), "subscriptions");
    expect(subs).not.toContain("/u/");
  });

  test("the community counts, all nine", () => {
    expect(text(block(html, "community"))).toContain(
      "社区 评论 5 回复 4 讨论帖 3 评价 2 弹幕 1 关注 6 粉丝 11 举报 0 投稿 8",
    );
  });

  test("empty lists say they are empty", () => {
    const empty = text(render({ detail: detail({ sessions: [], recentWatches: [], recentSubscriptions: [] }) }));
    expect(empty).toContain("没有登录中的设备");
    expect(empty).toContain("还没有观看记录");
    expect(empty).toContain("还没有追番");
  });
});

describe("the action row and what it opens", () => {
  const actions = (mode: UserDrawerMode, over: Partial<UserDetailPanelProps> = {}) =>
    block(render({ mode, ...over }), "actions");

  test("four actions, delete set apart, nothing open", () => {
    const html = actions("view");
    const buttons = [...html.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>([^<]+)<\/button>/g)].map(
      (m) => [m[2], m[1]],
    );
    expect(buttons).toEqual([
      ["编辑资料", "false"],
      ["重置密码", "false"],
      ["退出全部设备", "false"],
      ["删除用户…", "false"],
    ]);
    expect(html).not.toContain("data-form");
    expect(html).not.toContain("data-confirm");
  });

  test("编辑资料 opens the profile form with the current values and labelled fields", () => {
    const html = actions("edit");
    expect(html).toMatch(/aria-expanded="true"[^>]*>编辑资料</);
    expect(html).toContain('data-form="edit"');
    expect(html).toContain('value="fixture-reader"');
    expect(html).toContain('value="reader@example.test"');
    expect(html.match(/<label[^>]*for="[^"]+"/g)).toHaveLength(2);
    expect(text(html)).toContain("保存");
    expect(text(html)).toContain("取消");
  });

  test("重置密码 opens a password field with the minimum in its hint", () => {
    const html = decode(actions("password"));
    expect(html).toContain('data-form="password"');
    expect(html).toContain('type="password"');
    expect(html).toContain('placeholder="fixture-reader 的新密码 (≥6 位)"');
    expect(html).toContain('autoComplete="new-password"');
    expect(text(html)).toContain("保存密码");
  });

  test("退出全部设备 asks first, inline, with 取消 as the first button", () => {
    const html = actions("revokeAll");
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-label="确认退出全部设备"');
    expect(text(html)).toContain("让「fixture-reader」在所有设备上退出登录？对方下次打开网站时需要重新登录。");
    expect(html.indexOf(">取消<")).toBeLessThan(html.indexOf(">全部退出<"));
  });

  test("删除用户 asks first and says the past visits stay in the statistics", () => {
    const html = actions("delete");
    expect(html).toContain('data-confirm="delete"');
    expect(html).toContain('aria-label="确认删除用户"');
    expect(text(html)).toContain(
      "删除「fixture-reader」？账号、追番、观看记录和登录设备会一起删掉，不能恢复。这个账号过去的来访仍计入历史统计，不会让以前的日活和注册数变少。",
    );
    expect(text(html)).toContain("确认删除");
  });

  test("while a change is in flight the buttons say so without dropping focus", () => {
    const html = actions("delete", { busy: true });
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).not.toContain('disabled=""');
  });

  test("a failure is announced under the row", () => {
    const html = actions("delete", { actionError: "Cannot delete yourself" });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Cannot delete yourself");
  });
});

describe("what the fetch can leave it in", () => {
  const status = (s: DetailStatus, d: AdminUserDetail | null) => render({ status: s, detail: d });

  test("loading: the row's summary and the actions, no invented numbers", () => {
    const html = status("loading", null);
    expect(text(html)).toContain("fixture-reader");
    expect(text(html)).toContain("加载中…");
    expect(html).toContain('data-block="actions"');
    expect(html).not.toContain('data-block="tiles"');
  });

  test("a failed read says so and offers a retry, and the account can still be acted on", () => {
    const html = status("error", null);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("用户详情读取失败");
    expect(text(html)).toContain("重试");
    expect(html).toContain('data-block="actions"');
  });

  test("an account deleted elsewhere says it is gone and offers nothing to do to it", () => {
    const html = status("missing", null);
    expect(text(html)).toContain("这个用户已经不存在了");
    expect(html).not.toContain('data-block="actions"');
  });

  test("nothing depends on the machine's clock", () => {
    setSystemTime(new Date("2031-07-04T12:00:00Z"));
    const later = render();
    setSystemTime(new Date("2026-03-18T02:30:00Z"));
    expect(render()).toBe(later);
  });

  test("the English drawer reads its own dictionary", () => {
    const html = text(render({}, "en"));
    expect(html).toContain("User details");
    expect(html).toContain("3 days ago");
    expect(html).toContain("Sign out this device");
  });
});
