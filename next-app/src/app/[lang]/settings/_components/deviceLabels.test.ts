import { describe, expect, test } from "bun:test";
import {
  browserLabel,
  deviceName,
  lastActiveLabel,
  metaPrefix,
  placeLabel,
  signedInLabel,
} from "./deviceLabels";

const NOW = Date.parse("2026-10-22T10:30:00Z");
const HOUR = 60 * 60 * 1000;

describe("browserLabel", () => {
  test("translates the browsers whose names differ by language", () => {
    expect(browserLabel("WeChat", "zh")).toBe("微信");
    expect(browserLabel("WeChat", "zh-Hant")).toBe("微信");
    expect(browserLabel("WeChat", "en")).toBe("WeChat");
    expect(browserLabel("QQ", "zh")).toBe("QQ 浏览器");
    expect(browserLabel("QQ", "en")).toBe("QQ Browser");
    expect(browserLabel("QQ", "zh-Hant")).toBe("QQ 瀏覽器");
    expect(browserLabel("UC", "zh")).toBe("UC 浏览器");
    expect(browserLabel("UC", "en")).toBe("UC Browser");
    expect(browserLabel("Samsung", "zh")).toBe("三星浏览器");
    expect(browserLabel("Samsung", "en")).toBe("Samsung Internet");
    expect(browserLabel("Samsung", "zh-Hant")).toBe("三星瀏覽器");
  });

  test("shows every other browser as the API names it", () => {
    for (const name of ["Chrome", "Safari", "Edge", "Firefox", "Opera"]) {
      expect(browserLabel(name, "zh")).toBe(name);
      expect(browserLabel(name, "en")).toBe(name);
    }
  });

  test("does not find Object.prototype members in its table", () => {
    expect(browserLabel("constructor", "zh")).toBe("constructor");
    expect(browserLabel("__proto__", "en")).toBe("__proto__");
  });
});

describe("deviceName", () => {
  test("joins the system and the browser when both are known", () => {
    expect(deviceName("Mac", "Chrome", "zh")).toBe("Mac · Chrome");
    expect(deviceName("Android", "WeChat", "zh")).toBe("Android · 微信");
    expect(deviceName("Android", "WeChat", "en")).toBe("Android · WeChat");
  });

  test("uses whichever half is known", () => {
    expect(deviceName("iPad", "", "zh")).toBe("iPad");
    expect(deviceName("", "Safari", "en")).toBe("Safari");
    expect(deviceName("", "QQ", "zh-Hant")).toBe("QQ 瀏覽器");
  });

  test("names an unidentified device in each language", () => {
    expect(deviceName("", "", "zh")).toBe("未知设备");
    expect(deviceName("", "", "en")).toBe("Unknown device");
    expect(deviceName("  ", " ", "zh-Hant")).toBe("未知裝置");
  });
});

describe("placeLabel", () => {
  test("prefers the city", () => {
    expect(placeLabel("Shanghai", "CN", "zh")).toBe("Shanghai");
    expect(placeLabel("  Hangzhou ", null, "en")).toBe("Hangzhou");
  });

  test("falls back to the country's name in the reader's language", () => {
    expect(placeLabel(null, "JP", "zh")).toBe("日本");
    expect(placeLabel(null, "US", "en")).toBe("United States");
    expect(placeLabel(null, "US", "zh-Hant")).toBe("美國");
    expect(placeLabel("", "jp", "en")).toBe("Japan");
  });

  test("is empty when neither is usable", () => {
    expect(placeLabel(null, null, "zh")).toBe("");
    expect(placeLabel(undefined, undefined, "en")).toBe("");
    expect(placeLabel(" ", "", "zh")).toBe("");
    expect(placeLabel(null, "China", "en")).toBe("");
    expect(placeLabel(null, "C1", "en")).toBe("");
  });
});

describe("lastActiveLabel", () => {
  test("says the current session is in use, whatever its timestamp", () => {
    expect(lastActiveLabel("2026-10-01T00:00:00Z", true, "zh", NOW)).toBe("正在使用");
    expect(lastActiveLabel("2026-10-01T00:00:00Z", true, "en", NOW)).toBe("Active now");
    expect(lastActiveLabel("garbage", true, "zh-Hant", NOW)).toBe("正在使用");
  });

  test("gives every other session its relative time from the pinned clock", () => {
    const twoHoursAgo = new Date(NOW - 2 * HOUR).toISOString();
    expect(lastActiveLabel(twoHoursAgo, false, "zh", NOW)).toBe("2 小时前");
    expect(lastActiveLabel(twoHoursAgo, false, "en", NOW)).toBe("2h ago");
    const threeDaysAgo = new Date(NOW - 72 * HOUR).toISOString();
    expect(lastActiveLabel(threeDaysAgo, false, "zh-Hant", NOW)).toBe("3 天前");
  });

  test("is empty for an unparseable timestamp", () => {
    expect(lastActiveLabel("not a date", false, "zh", NOW)).toBe("");
  });
});

describe("signedInLabel", () => {
  test("names the day in each language", () => {
    expect(signedInLabel("2026-10-21T15:09:00Z", "zh")).toBe("10月21日登录");
    expect(signedInLabel("2026-10-21T15:09:00Z", "en")).toBe("Signed in Oct 21");
    expect(signedInLabel("2026-10-21T15:09:00Z", "zh-Hant")).toBe("10月21日登入");
  });

  test("counts days on the site's clock (UTC+8), not UTC", () => {
    // 16:30 UTC is 00:30 the next morning in Shanghai.
    expect(signedInLabel("2026-10-21T16:30:00Z", "zh")).toBe("10月22日登录");
    expect(signedInLabel("2026-09-30T20:00:00Z", "en")).toBe("Signed in Oct 1");
  });

  test("is empty for an unparseable timestamp", () => {
    expect(signedInLabel("", "zh")).toBe("");
    expect(signedInLabel("yesterday", "en")).toBe("");
  });
});

describe("metaPrefix", () => {
  test("puts a separator between the place and the time", () => {
    expect(metaPrefix("上海", "2 小时前")).toBe("上海 · ");
  });

  test("leaves the separator out when either half is missing", () => {
    expect(metaPrefix("", "2 小时前")).toBe("");
    expect(metaPrefix("上海", "")).toBe("上海");
    expect(metaPrefix("", "")).toBe("");
  });
});
