import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import type { AdminUserRow, AdminUsersPage } from "../_types/users";
import { UserRow, UserRowMenu } from "./UserRow";
import { UsersSection } from "./UsersSection";
import { UsersToolbar, type UsersToolbarProps } from "./UsersToolbar";

// renderToStaticMarkup, as the other admin render tests: no jsdom, no new
// dependency. What is pinned is the server HTML — what hydration starts from:
// the chips and their counts, the columns, the +08 dates, the strip, the
// dimmed zeros, the device, the menu, and that none of it reads the clock.
// The interactive half (debounced search, the drawer opening, Esc) is in
// e2e/specs/sandbox/admin.spec.ts.
//
// Every fixture is synthetic: invented names, ids, dates and counts.

const TODAY = "2026-03-18";

function row(over: Partial<AdminUserRow> = {}): AdminUserRow {
  return {
    _id: "00000000-0000-4000-8000-000000000001",
    username: "fixture-newcomer",
    email: "newcomer@example.test",
    role: null,
    // 23:30 UTC on the 17th is 07:30 on the 18th in Shanghai.
    createdAt: "2026-03-17T23:30:00Z",
    lastSeenAt: "2026-03-18T02:47:00Z",
    activeDays: 1,
    logins: 0,
    subscriptions: 0,
    followers: 0,
    ratings: 0,
    watchedEpisodes: 0,
    returned: false,
    recentActiveDates: [TODAY],
    lastDevice: { kind: "desktop", os: "Windows", browser: "Edge", country: "CN", lastUsedAt: "2026-03-18T02:47:00Z" },
    ...over,
  };
}

const NEWCOMER = row();
const REGULAR = row({
  _id: "00000000-0000-4000-8000-000000000002",
  username: "fixture-regular",
  email: "regular@example.test",
  createdAt: "2025-11-02T04:00:00Z",
  lastSeenAt: "2026-03-15T09:42:00Z",
  activeDays: 64,
  logins: 3,
  subscriptions: 37,
  ratings: 12,
  watchedEpisodes: 205,
  returned: true,
  recentActiveDates: ["2026-02-16", "2026-02-17", "2026-03-01", "2026-03-15"],
  lastDevice: { kind: "phone", os: "Android", browser: "QQ", country: "JP", lastUsedAt: "2026-03-15T09:26:00Z" },
});
const ADMIN = row({
  _id: "00000000-0000-4000-8000-000000000003",
  username: "fixture-admin",
  email: "admin@example.test",
  role: "admin",
  createdAt: "2025-06-01T00:00:00Z",
  lastSeenAt: "2026-03-17T15:51:00Z",
  activeDays: 120,
  subscriptions: 4,
  recentActiveDates: ["2026-03-17"],
  lastDevice: { kind: "laptop", os: "", browser: "Edge", country: null, lastUsedAt: "2026-03-17T15:51:00Z" },
});
const SILENT = row({
  _id: "00000000-0000-4000-8000-000000000004",
  username: "fixture-silent",
  email: "silent@example.test",
  createdAt: "2025-01-05T01:00:00Z",
  lastSeenAt: null,
  activeDays: 0,
  recentActiveDates: [],
  lastDevice: null,
});

function page(over: Partial<AdminUsersPage> = {}): AdminUsersPage {
  return {
    data: [NEWCOMER, REGULAR, ADMIN, SILENT],
    hasMore: true,
    total: 4321,
    page: 1,
    today: TODAY,
    segments: { all: 4321, active7: 210, returned: 97, neverReturned: 4224, subscribed: 1500, admin: 2 },
    ...over,
  };
}

function render(node: ReactNode, lang: Lang = "zh"): string {
  return renderToStaticMarkup(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Rendered text with tags out of the way. */
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** The markup of the <tr> for one user. */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-user-row="${id}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</tr>", start));
}

/** One segment chip's text. */
function chip(html: string, segment: string): string {
  const m = new RegExp(`<button[^>]*data-segment="${segment}"[^>]*>(.*?)</button>`).exec(html);
  return m ? text(m[1]).trim() : "";
}

afterEach(() => {
  setSystemTime();
});

describe("the list header and the segment chips", () => {
  const html = render(<UsersSection initial={page()} />);

  test("the title counts every account, not the filtered page", () => {
    expect(text(html)).toContain("用户管理");
    expect(text(html)).toContain("共 4,321 个用户");
  });

  test("six chips, each with its segment's size, 全部 pressed", () => {
    expect(chip(html, "all")).toBe("全部 4,321");
    expect(chip(html, "active7")).toBe("近 7 天来过 210");
    expect(chip(html, "returned")).toBe("回访过 97");
    expect(chip(html, "neverReturned")).toBe("没有回访记录 4,224");
    expect(chip(html, "subscribed")).toBe("有追番 1,500");
    expect(chip(html, "admin")).toBe("管理员 2");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-segment="all"/);
    expect(html).toContain('role="group" aria-label="按人群筛选"');
  });

  test("创建用户 starts collapsed and says it expands something", () => {
    expect(html).toMatch(/aria-expanded="false"[^>]*>\+ 创建用户</);
    // The form itself is not in the page until the button is pressed.
    expect(html).not.toContain('name="password"');
  });

  test("search and sort are labelled controls, sort in the canvas's order", () => {
    expect(html).toContain('aria-label="搜索用户名或邮箱"');
    expect(html).toContain('placeholder="搜索用户名或邮箱..."');
    const options = [...html.matchAll(/<option value="(\w+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["lastSeen", "最近活跃"],
      ["joined", "注册时间"],
      ["activeDays", "活跃天数"],
      ["subscriptions", "追番数"],
      ["watched", "看过集数"],
    ]);
  });
});

describe("the table", () => {
  const html = render(<UsersSection initial={page()} />);

  test("the columns, with the sorted one marked for assistive tech as well as by the arrow", () => {
    const heads = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(heads).toEqual(["用户", "注册", "最近活跃 ↓", "近 30 天", "追番", "评分", "看过集数", "最近设备", "操作"]);
    expect(html.match(/aria-sort="descending"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-sort="descending">最近活跃/);
  });

  test("registration is the +08 day: 23:30 UTC on the 17th is the 18th", () => {
    const tr = rowHtml(html, NEWCOMER._id);
    expect(tr).toContain(">2026-03-18<");
    expect(tr).not.toContain("2026-03-17");
  });

  test("seen today: the time, the signup-day note, and the full +08 time on hover", () => {
    const tr = decode(rowHtml(html, NEWCOMER._id));
    expect(tr).toContain("今天 10:47");
    expect(tr).toContain("注册当天");
    expect(tr).toContain('title="2026-03-18 10:47（北京时间）"');
  });

  test("seen days ago: the count of days, then the exact time under it", () => {
    const tr = text(rowHtml(html, REGULAR._id));
    expect(tr).toContain("3 天前");
    expect(tr).toContain("03-15 17:42");
  });

  test("seen yesterday at 23:51 on the +08 clock", () => {
    expect(text(rowHtml(html, ADMIN._id))).toContain("昨天 23:51");
  });

  test("never seen is a dash with the explanation, never a date", () => {
    const tr = rowHtml(html, SILENT._id);
    expect(decode(tr)).toContain('title="没有任何活跃记录。注意这说的是我们的记录，不是这个人没来过。"');
    expect(tr).toContain(">—<");
  });

  test("the strip: thirty cells ending on today, the active ones marked, and the two counts", () => {
    const tr = rowHtml(html, REGULAR._id);
    const at = tr.indexOf('data-strip="true"');
    const strip = tr.slice(at, tr.indexOf("近 30 天 ", at));
    expect(strip.match(/data-active="(true|false)"/g)).toHaveLength(30);
    // 02-16 is today-30 and outside the strip; the other three are in it.
    expect(strip.match(/data-active="true"/g)).toHaveLength(3);
    expect(strip.match(/data-today="true"/g)).toHaveLength(1);
    expect(tr).toContain('aria-label="近 30 天来过 3 天"');
    expect(text(tr)).toContain("近 30 天 3 天 · 累计 64 天");
  });

  test("the three counts dim at zero and only at zero", () => {
    const zeros = (id: string) => (rowHtml(html, id).match(/data-zero="true"/g) ?? []).length;
    expect(zeros(NEWCOMER._id)).toBe(3);
    expect(zeros(REGULAR._id)).toBe(0);
    expect(text(rowHtml(html, REGULAR._id))).toContain("37 12 205");
  });

  test("the device: both halves and the country; the unknown half named; none is a dash", () => {
    expect(text(rowHtml(html, NEWCOMER._id))).toContain("Windows · Edge CN");
    expect(text(rowHtml(html, REGULAR._id))).toContain("Android · QQ 浏览器 JP");
    expect(text(rowHtml(html, ADMIN._id))).toContain("未知系统 · Edge");
    expect(rowHtml(html, SILENT._id).match(/>—</g)).toHaveLength(2);
  });

  test("ADMIN marks the admin and nobody else", () => {
    expect(rowHtml(html, ADMIN._id)).toContain(">ADMIN<");
    expect(rowHtml(html, NEWCOMER._id)).not.toContain(">ADMIN<");
  });

  test("the username opens the drawer, and ⋯ is a labelled menu button", () => {
    const tr = rowHtml(html, NEWCOMER._id);
    expect(tr).toMatch(/<button type="button"[^>]*>fixture-newcomer<\/button>/);
    expect(tr).toContain('aria-label="fixture-newcomer 的更多操作"');
    expect(tr).toContain('aria-haspopup="menu"');
    expect(tr).toContain('aria-expanded="false"');
  });

  test("the pager counts the filtered total and knows there is a next page", () => {
    expect(text(html)).toContain("第 1 页 · 共 4,321 条");
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>← 上一页<\/button>/);
    expect(html).toMatch(/<button type="button"(?![^>]*disabled)[^>]*>下一页 →<\/button>/);
  });

  test("no drawer is in the server HTML", () => {
    expect(html).not.toContain('role="dialog"');
  });
});

describe("degenerate pages", () => {
  test("an empty result says so", () => {
    expect(text(render(<UsersSection initial={page({ data: [], total: 0, hasMore: false })} />))).toContain(
      "没有匹配的用户",
    );
  });

  test("a failed server fetch says the list could not be read, and invents no zeroes", () => {
    const html = render(<UsersSection initial={null} />);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("用户列表读取失败");
    expect(text(html)).toContain("重试");
    expect(text(html)).not.toContain("共 0 个用户");
    expect(chip(html, "all")).toBe("全部");
  });

  test("nothing in the server HTML depends on the machine's clock", () => {
    setSystemTime(new Date("2031-07-04T12:00:00Z"));
    const later = render(<UsersSection initial={page()} />);
    setSystemTime(new Date("2026-03-18T02:30:00Z"));
    const now = render(<UsersSection initial={page()} />);
    expect(later).toBe(now);
  });

  test("the English list reads its own dictionary", () => {
    const html = render(<UsersSection initial={page()} />, "en");
    expect(chip(html, "all")).toBe("All 4,321");
    expect(text(html)).toContain("Today 10:47");
    expect(text(html)).toContain("Signup day");
  });

  test("the Traditional list reads its own dictionary", () => {
    const html = render(<UsersSection initial={page()} />, "zh-Hant");
    expect(text(html)).toContain("使用者管理");
    expect(text(html)).toContain("註冊當天");
  });
});

describe("the depth chip", () => {
  const props = (over: Partial<UsersToolbarProps>): UsersToolbarProps => ({
    segments: page().segments,
    segment: "all",
    onSegment: () => {},
    depth: null,
    onClearDepth: () => {},
    search: "",
    onSearch: () => {},
    onSearchSubmit: () => {},
    sort: "lastSeen",
    onSort: () => {},
    ...over,
  });

  test("a range bucket shows as a removable chip after the segments", () => {
    const html = render(<UsersToolbar {...props({ depth: { days: 30, min: 3, max: 6 } })} />);
    const m = /<button[^>]*data-depth-chip="true"[^>]*>(.*?)<\/button>/.exec(html);
    expect(m).not.toBeNull();
    expect(text(m![1]).trim()).toBe("近 30 天来过 3–6 天 ×");
    expect(m![0]).toContain('aria-label="移除筛选：近 30 天来过 3–6 天"');
  });

  test("a one-value bucket reads as that value", () => {
    const html = render(<UsersToolbar {...props({ depth: { days: 30, min: 2, max: 2 } })} />);
    expect(text(html)).toContain("近 30 天来过 2 天");
  });

  test("no filter, no chip; a segment without a size, no count", () => {
    const html = render(<UsersToolbar {...props({ segments: { all: 5 } })} />);
    expect(html).not.toContain("data-depth-chip");
    expect(chip(html, "all")).toBe("全部 5");
    expect(chip(html, "admin")).toBe("管理员");
  });
});

describe("the row menu", () => {
  test("five actions, delete last behind a separator, each tagged with the drawer mode it opens", () => {
    const html = render(<UserRowMenu username="fixture-newcomer" onChoose={() => {}} onClose={() => {}} />);
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="fixture-newcomer 的更多操作"');
    const items = [...html.matchAll(/role="menuitem"[^>]*data-menu-item="(\w+)"[^>]*>([^<]+)</g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(items).toEqual([
      ["view", "查看详情"],
      ["edit", "编辑资料"],
      ["password", "重置密码"],
      ["revokeAll", "退出全部设备"],
      ["delete", "删除用户…"],
    ]);
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf('data-menu-item="delete"'));
    expect(html.indexOf('role="separator"')).toBeGreaterThan(html.indexOf('data-menu-item="revokeAll"'));
  });

  test("an open row says so on its button (the menu itself is portalled by the browser)", () => {
    const html = render(
      <table>
        <tbody>
          <UserRow user={NEWCOMER} today={TODAY} menuOpen onMenu={() => {}} onOpen={() => {}} />
        </tbody>
      </table>,
    );
    expect(html).toContain('aria-expanded="true"');
  });
});
