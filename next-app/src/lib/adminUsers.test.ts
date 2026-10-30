import { describe, expect, test } from "bun:test";

import {
  ADMIN_USERS_DEPTH_EVENT,
  DEFAULT_USERS_QUERY,
  activityStrip,
  addDays,
  avatarColor,
  avatarInitial,
  countryCode,
  daysBetween,
  depthChipLabel,
  deviceLabel,
  formatCount,
  formatScore,
  isDay,
  isUserSegment,
  isUserSort,
  menuPlacement,
  monthDay,
  parseDepthDetail,
  passwordProblem,
  profilePatch,
  readUserDetail,
  readUsersPage,
  relativeDay,
  returnNote,
  shanghaiDate,
  shanghaiDateTime,
  shortDate,
  shortDateTime,
  usersQueryString,
  visitCalendar,
  type AdminUsersQuery,
} from "./adminUsers";

// Every fixture here is synthetic: invented names, invented dates, invented
// counts. The reporting day is Asia/Shanghai (+08) and every assertion about
// a calendar day is about that day, never the machine's.

const TODAY = "2026-03-18"; // a Wednesday

describe("+08 instants", () => {
  test("23:30 UTC is already the next day in Shanghai", () => {
    expect(shanghaiDate("2026-03-17T23:30:00Z")).toBe("2026-03-18");
    expect(shanghaiDateTime("2026-03-17T23:30:00Z")).toBe("2026-03-18 07:30");
  });

  test("an instant with its own offset lands on the same +08 wall clock", () => {
    // 2026-03-18 01:05 at -05:00 is 06:05 UTC, 14:05 in Shanghai.
    expect(shanghaiDateTime("2026-03-18T01:05:00-05:00")).toBe("2026-03-18 14:05");
  });

  test("15:59:59 UTC is still the same day, 16:00 UTC is the next", () => {
    expect(shanghaiDate("2026-03-17T15:59:59Z")).toBe("2026-03-17");
    expect(shanghaiDate("2026-03-17T16:00:00Z")).toBe("2026-03-18");
  });

  test("an unparseable instant renders as nothing rather than as 1970", () => {
    expect(shanghaiDate("not a date")).toBe("");
    expect(shanghaiDateTime("")).toBe("");
    expect(shanghaiDate(null)).toBe("");
  });

  test("short forms drop the year only when it is today's year", () => {
    expect(shortDateTime("2026-03-15T09:42:00Z", TODAY)).toBe("03-15 17:42");
    expect(shortDateTime("2025-12-31T17:00:00Z", TODAY)).toBe("01-01 01:00");
    expect(shortDateTime("2025-12-30T17:00:00Z", TODAY)).toBe("2025-12-31 01:00");
    expect(shortDate("2026-04-02", TODAY)).toBe("04-02");
    expect(shortDate("2027-01-02", TODAY)).toBe("2027-01-02");
  });
});

describe("calendar days are counted, not parsed with new Date(str)", () => {
  test("adding days crosses months, years and a leap day", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-18", -29)).toBe("2026-02-17");
  });

  test("days between two calendar days", () => {
    expect(daysBetween("2026-03-17", "2026-03-18")).toBe(1);
    expect(daysBetween("2026-03-18", "2026-03-18")).toBe(0);
    expect(daysBetween("2026-03-18", "2026-03-11")).toBe(-7);
    expect(daysBetween("garbage", "2026-03-18")).toBeNull();
  });

  test("only a well-formed YYYY-MM-DD is a reporting day", () => {
    expect(isDay("2026-03-18")).toBe(true);
    expect(isDay("2026-3-18")).toBe(false);
    expect(isDay("2026-03-18T00:00:00Z")).toBe(false);
    expect(isDay(20260318)).toBe(false);
  });

  test("the legend's short day: month without its zero, day with it", () => {
    expect(monthDay("2026-08-28")).toBe("8-28");
    expect(monthDay("2026-11-05")).toBe("11-05");
  });
});

describe("guards on what the browser sends back", () => {
  test("segments and sorts are the wire's own words", () => {
    expect(isUserSegment("neverReturned")).toBe(true);
    expect(isUserSegment("constructor")).toBe(false);
    expect(isUserSort("watched")).toBe(true);
    expect(isUserSort("password")).toBe(false);
  });

  test("a country chip only for a two-letter code", () => {
    expect(countryCode("cn")).toBe("CN");
    expect(countryCode(" JP ")).toBe("JP");
    expect(countryCode("XYZ")).toBeNull();
    expect(countryCode(null)).toBeNull();
  });
});

describe("relative labels come from the payload's today, around midnight", () => {
  test("00:00 in Shanghai is today, one second earlier is yesterday", () => {
    // 2026-03-17T16:00Z = 2026-03-18 00:00 +08.
    expect(relativeDay("2026-03-17T16:00:00Z", TODAY)).toEqual({
      kind: "today",
      days: 0,
      date: "2026-03-18",
      time: "00:00",
    });
    expect(relativeDay("2026-03-17T15:59:59Z", TODAY)).toEqual({
      kind: "yesterday",
      days: 1,
      date: "2026-03-17",
      time: "23:59",
    });
  });

  test("a 23:30 UTC visit is this morning, not yesterday", () => {
    expect(relativeDay("2026-03-17T23:30:00Z", TODAY)?.kind).toBe("today");
  });

  test("two and more days back count days", () => {
    expect(relativeDay("2026-03-16T15:59:00Z", TODAY)).toMatchObject({ kind: "daysAgo", days: 2 });
    expect(relativeDay("2026-01-01T04:00:00Z", TODAY)).toMatchObject({ kind: "daysAgo", days: 76 });
  });

  test("an instant past the payload's today is not called today", () => {
    expect(relativeDay("2026-03-18T17:00:00Z", TODAY)).toMatchObject({ kind: "later", date: "2026-03-19" });
  });

  test("nothing recorded is null, never a date", () => {
    expect(relativeDay(null, TODAY)).toBeNull();
    expect(relativeDay("bad", TODAY)).toBeNull();
  });

  test("the same instant renders the same against the same today, whatever the machine clock", () => {
    const a = relativeDay("2026-03-17T23:30:00Z", TODAY);
    const b = relativeDay("2026-03-17T23:30:00Z", TODAY);
    expect(a).toEqual(b);
  });
});

describe("the sub-line under 最近活跃", () => {
  const row = (createdAt: string, lastSeenAt: string | null, recentActiveDates: string[]) => ({
    createdAt,
    lastSeenAt,
    recentActiveDates,
  });

  test("last seen on the +08 signup day says so", () => {
    // Signed up 23:40 UTC on the 17th = 07:40 on the 18th in Shanghai.
    expect(returnNote(row("2026-03-17T23:40:00Z", "2026-03-18T02:00:00Z", [TODAY]), TODAY)).toEqual({
      kind: "signupDay",
    });
  });

  test("a first return names how many days after signup it came", () => {
    const r = row("2026-03-16T02:00:00Z", "2026-03-18T01:00:00Z", ["2026-03-16", "2026-03-18"]);
    expect(returnNote(r, TODAY)).toEqual({ kind: "firstReturn", days: 2 });
  });

  test("someone who has come back more than once gets no note", () => {
    const r = row("2026-03-10T02:00:00Z", "2026-03-18T01:00:00Z", ["2026-03-10", "2026-03-12", "2026-03-18"]);
    expect(returnNote(r, TODAY)).toBeNull();
  });

  test("a signup older than the strip cannot be judged, so no note", () => {
    const r = row("2026-01-02T02:00:00Z", "2026-03-18T01:00:00Z", ["2026-03-18"]);
    expect(returnNote(r, TODAY)).toBeNull();
  });

  test("nothing recorded, no note", () => {
    expect(returnNote(row("2026-03-17T02:00:00Z", null, []), TODAY)).toBeNull();
  });
});

describe("the 30-day strip", () => {
  test("thirty cells ending on today, active where the payload says", () => {
    const cells = activityStrip(["2026-02-16", "2026-02-17", "2026-03-01", TODAY], TODAY);
    expect(cells).toHaveLength(30);
    expect(cells[0]).toEqual({ date: "2026-02-17", active: true, today: false });
    expect(cells[29]).toEqual({ date: TODAY, active: true, today: true });
    // 02-16 is today-30: outside the window and not drawn.
    expect(cells.filter((c) => c.active).map((c) => c.date)).toEqual(["2026-02-17", "2026-03-01", TODAY]);
    expect(cells.filter((c) => c.today)).toHaveLength(1);
  });

  test("a window across the leap day keeps thirty distinct days", () => {
    const cells = activityStrip([], "2028-03-10");
    expect(cells[0].date).toBe("2028-02-10");
    expect(cells.map((c) => c.date)).toContain("2028-02-29");
    expect(new Set(cells.map((c) => c.date)).size).toBe(30);
  });

  test("a missing list draws an empty strip instead of throwing", () => {
    expect(activityStrip(undefined, TODAY).every((c) => !c.active)).toBe(true);
  });
});

describe("the 90-day visit calendar", () => {
  // 2026-03-18 is a Wednesday, so the window [12-19, 03-18] starts on a
  // Friday: the grid starts the Monday before and ends the Sunday after.
  const days = [
    { date: "2025-12-19", recorded: false },
    { date: "2026-01-05", recorded: false },
    { date: "2026-02-20", recorded: true },
    { date: TODAY, recorded: true },
    { date: "2025-12-01", recorded: true }, // outside the window, ignored
  ];
  const cal = visitCalendar(days, TODAY);

  test("Monday-first week columns covering the whole window", () => {
    expect(cal.weeks[0].start).toBe("2025-12-15");
    expect(cal.weeks[cal.weeks.length - 1].start).toBe("2026-03-16");
    expect(cal.weeks).toHaveLength(14);
    for (const week of cal.weeks) {
      expect(week.cells.map((c) => c.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  test("cells before the window and after today are outside, not 'no visit'", () => {
    const first = cal.weeks[0].cells;
    expect(first.slice(0, 4).every((c) => c.state === "outside")).toBe(true);
    expect(first[4]).toMatchObject({ date: "2025-12-19", state: "reconstructed" });
    const last = cal.weeks[cal.weeks.length - 1].cells;
    expect(last[2]).toMatchObject({ date: TODAY, state: "recorded", today: true });
    expect(last.slice(3).every((c) => c.state === "outside")).toBe(true);
  });

  test("recorded, reconstructed and none are told apart", () => {
    const all = cal.weeks.flatMap((w) => w.cells);
    expect(all.find((c) => c.date === "2026-01-05")?.state).toBe("reconstructed");
    expect(all.find((c) => c.date === "2026-02-20")?.state).toBe("recorded");
    expect(all.find((c) => c.date === "2026-02-21")?.state).toBe("none");
    expect(all.filter((c) => c.today)).toHaveLength(1);
  });

  test("the counts under it", () => {
    expect(cal.active).toBe(4);
    expect(cal.reconstructed).toBe(2);
    // 02-20 and today are inside [02-17, 03-18].
    expect(cal.last30).toBe(2);
  });

  test("a month is labelled on the column that holds its first day", () => {
    const labelled = cal.weeks.map((w, i) => [i, w.month]).filter(([, m]) => m !== null);
    // Column 0 (12-15..12-21) has no 1st and neither does column 1, so it
    // carries December; Jan 1 falls in column 2, Feb 1 in 6, Mar 1 in 10.
    expect(labelled).toEqual([
      [0, 12],
      [2, 1],
      [6, 2],
      [10, 3],
    ]);
  });
});

describe("the list query", () => {
  const q = (over: Partial<AdminUsersQuery>): string => usersQueryString({ ...DEFAULT_USERS_QUERY, ...over });

  test("the default query is the one the server already rendered", () => {
    expect(usersQueryString(DEFAULT_USERS_QUERY)).toBe("page=1");
  });

  test("search is trimmed and encoded", () => {
    expect(q({ q: "  ali ce&x " })).toBe("page=1&q=ali+ce%26x");
    expect(q({ q: "   " })).toBe("page=1");
  });

  test("segment and sort are sent only when not the default", () => {
    expect(q({ segment: "neverReturned", sort: "watched", page: 3 })).toBe(
      "page=3&segment=neverReturned&sort=watched",
    );
    expect(q({ segment: "all", sort: "lastSeen" })).toBe("page=1");
  });

  test("the depth filter is all three parameters or none", () => {
    expect(q({ depth: { days: 30, min: 3, max: 6 } })).toBe("page=1&depthDays=30&depthMin=3&depthMax=6");
    expect(q({ q: "x", segment: "subscribed", sort: "joined", depth: { days: 7, min: 2, max: 2 } })).toBe(
      "page=1&q=x&segment=subscribed&sort=joined&depthDays=7&depthMin=2&depthMax=2",
    );
  });
});

describe("the activity panel's depth event", () => {
  test("the event name is the shared one", () => {
    expect(ADMIN_USERS_DEPTH_EVENT).toBe("admin:users-depth");
  });

  test("a valid bucket is accepted as is", () => {
    expect(parseDepthDetail({ days: 30, min: 3, max: 6 })).toEqual({ days: 30, min: 3, max: 6 });
    expect(parseDepthDetail({ days: 7, min: 1, max: 1 })).toEqual({ days: 7, min: 1, max: 1 });
  });

  test("an open-ended or oversized max is clamped to the window", () => {
    expect(parseDepthDetail({ days: 30, min: 14, max: 45 })).toEqual({ days: 30, min: 14, max: 30 });
    expect(parseDepthDetail({ days: 90, min: 14, max: Infinity })).toEqual({ days: 90, min: 14, max: 90 });
  });

  test("anything else is ignored", () => {
    for (const bad of [
      null,
      undefined,
      "30",
      { days: 14, min: 1, max: 2 },
      { days: 30, min: 0, max: 2 },
      { days: 30, min: 4, max: 3 },
      { days: 30, min: 1.5, max: 3 },
      { days: 30, min: "1", max: 3 },
      { days: 30, min: 31, max: 40 },
    ]) {
      expect(parseDepthDetail(bad)).toBeNull();
    }
  });

  test("the chip label", () => {
    const templates = { range: "近 {{days}} 天来过 {{min}}–{{max}} 天", single: "近 {{days}} 天来过 {{n}} 天" };
    expect(depthChipLabel({ days: 30, min: 3, max: 6 }, templates)).toBe("近 30 天来过 3–6 天");
    expect(depthChipLabel({ days: 30, min: 2, max: 2 }, templates)).toBe("近 30 天来过 2 天");
  });
});

describe("payload guards", () => {
  const page = {
    data: [
      {
        _id: "00000000-0000-4000-8000-000000000001",
        username: "fixture-a",
        email: "a@example.test",
        role: null,
        createdAt: "2026-03-01T02:00:00Z",
        lastSeenAt: null,
        activeDays: 0,
        logins: 0,
        subscriptions: 0,
        followers: 0,
        ratings: 0,
        watchedEpisodes: 0,
        returned: false,
      },
    ],
    hasMore: false,
    total: 1,
    page: 1,
    today: TODAY,
    segments: { all: 1, active7: 0, returned: 0, neverReturned: 1, subscribed: 0, admin: 0 },
  };

  test("a page missing a row's arrays still reads, with them empty", () => {
    const read = readUsersPage(page);
    expect(read?.data[0].recentActiveDates).toEqual([]);
    expect(read?.data[0].lastDevice).toBeNull();
    expect(read?.today).toBe(TODAY);
  });

  test("a page without today or data is not a page", () => {
    expect(readUsersPage({ ...page, today: undefined })).toBeNull();
    expect(readUsersPage({ ...page, today: "18/03/2026" })).toBeNull();
    expect(readUsersPage({ ...page, data: null })).toBeNull();
    expect(readUsersPage(null)).toBeNull();
  });

  test("a detail missing a block is refused, not half-rendered", () => {
    const detail = {
      today: TODAY,
      instrumentedSince: null,
      user: { _id: "x", username: "fixture-a", email: "a@example.test", role: null, createdAt: "", isPublic: false, avatarUrl: null },
      activity: { activeDays: 0, recordedDays: 0, lastSeenAt: null, logins: 0, requests: 0, days90: [] },
      subscriptions: { total: 0, watching: 0, completed: 0, planToWatch: 0, dropped: 0, rated: 0, avgScore: null, lastUpdatedAt: null },
      watches: { total: 0, lastWatchedAt: null },
      recentWatches: [],
      recentSubscriptions: [],
      sessions: [],
      community: { comments: 0, replies: 0, threads: 0, reviews: 0, danmaku: 0, following: 0, followers: 0, reportsFiled: 0, editSubmissions: 0 },
    };
    expect(readUserDetail(detail)).not.toBeNull();
    expect(readUserDetail({ ...detail, sessions: undefined })).toBeNull();
    expect(readUserDetail({ ...detail, activity: { ...detail.activity, days90: null } })).toBeNull();
    expect(readUserDetail({ ...detail, user: { username: "no id" } })).toBeNull();
  });
});

describe("display helpers", () => {
  test("counts group the same on the server and in any browser", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
  });

  test("avatar initial and colour are stable per name", () => {
    expect(avatarInitial("  kiwi")).toBe("K");
    expect(avatarInitial("夜猫")).toBe("夜");
    expect(avatarInitial("")).toBe("?");
    expect(avatarColor("kiwi")).toBe(avatarColor("kiwi"));
    expect(avatarColor("kiwi")).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("an average score keeps one decimal", () => {
    expect(formatScore(8.46)).toBe("8.5");
    expect(formatScore(7)).toBe("7.0");
  });

  test("the row menu opens below its button, or above when the bottom is too close", () => {
    const viewport = { width: 1280, height: 800 };
    expect(menuPlacement({ top: 300, bottom: 332, right: 1200 }, viewport, 220)).toEqual({
      top: 336,
      bottom: null,
      right: 80,
    });
    expect(menuPlacement({ top: 700, bottom: 732, right: 1200 }, viewport, 220)).toEqual({
      top: null,
      bottom: 104,
      right: 80,
    });
    // A button at the very right edge still leaves the menu on screen.
    expect(menuPlacement({ top: 10, bottom: 42, right: 1279 }, viewport, 220).right).toBe(8);
  });

  test("a device names both halves, or says which half is unknown", () => {
    const words = { unknownOs: "未知系统", unknownBrowser: "未知浏览器", unknownDevice: "未知设备" };
    expect(deviceLabel("Windows", "Edge", words)).toBe("Windows · Edge");
    expect(deviceLabel("", "Edge", words)).toBe("未知系统 · Edge");
    expect(deviceLabel("Android", "", words)).toBe("Android · 未知浏览器");
    expect(deviceLabel(" ", "", words)).toBe("未知设备");
  });
});

describe("the edit form's validation (kept from the old row)", () => {
  const current = { username: "fixture-a", email: "a@example.test" };

  test("only changed fields are sent, trimmed", () => {
    expect(profilePatch({ username: " fixture-b ", email: "a@example.test" }, current)).toEqual({
      kind: "patch",
      patch: { username: "fixture-b" },
    });
    expect(profilePatch({ username: "fixture-a", email: "b@example.test" }, current)).toEqual({
      kind: "patch",
      patch: { email: "b@example.test" },
    });
  });

  test("nothing changed is not a request", () => {
    expect(profilePatch({ username: "fixture-a ", email: " a@example.test" }, current)).toEqual({ kind: "unchanged" });
  });

  test("username length and email shape are refused before the network", () => {
    expect(profilePatch({ username: "ab", email: "a@example.test" }, current)).toEqual({
      kind: "invalid",
      reason: "usernameLength",
    });
    expect(profilePatch({ username: "x".repeat(51), email: "a@example.test" }, current)).toMatchObject({
      reason: "usernameLength",
    });
    expect(profilePatch({ username: "fixture-a", email: "not-an-email" }, current)).toEqual({
      kind: "invalid",
      reason: "emailFormat",
    });
  });

  test("a password shorter than six is refused", () => {
    expect(passwordProblem("12345")).toBe("short");
    expect(passwordProblem("123456")).toBeNull();
  });
});
