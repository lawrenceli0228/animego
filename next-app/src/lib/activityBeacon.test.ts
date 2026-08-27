import { describe, expect, test } from "bun:test";
import { LOCALES } from "@/lib/i18n/locale";
import { surfaceForPath, type ActivitySurface } from "@/lib/activityBeacon";

describe("surfaceForPath", () => {
  test("maps the default-locale routes to their surface", () => {
    const cases: Array<[string, ActivitySurface]> = [
      ["/", "home"],
      ["/anime/21", "anime"],
      ["/anime", "anime"],
      ["/player", "watch"],
      ["/player/abc", "watch"],
      ["/seasonal", "seasonal"],
      ["/calendar", "seasonal"],
      ["/library", "library"],
      ["/search?q=x", "other"], // query strings are not part of a pathname
      ["/search", "search"],
      ["/u/someone", "profile"],
      ["/profile", "profile"],
      ["/settings", "profile"],
      ["/login", "auth"],
      ["/register", "auth"],
      ["/forgot-password", "auth"],
      ["/reset-password/token", "auth"],
      ["/faq", "other"],
      ["/admin", "other"],
      ["", "other"],
    ];
    for (const [path, want] of cases) {
      expect(surfaceForPath(path)).toBe(want);
    }
  });

  // The failure this guards against is quiet and plausible: every visit under
  // a prefixed locale filing itself as "other", so the surface breakdown
  // slowly becomes a measure of how many people read in Simplified Chinese.
  test("is locale-agnostic across every published locale", () => {
    for (const locale of LOCALES) {
      const prefix = locale === "zh-Hans" ? "" : `/${locale}`;
      expect(surfaceForPath(`${prefix}/anime/21`)).toBe("anime");
      expect(surfaceForPath(`${prefix}/player`)).toBe("watch");
      expect(surfaceForPath(prefix || "/")).toBe("home");
    }
  });

  // A prefix must match a whole segment. Without the boundary check,
  // "/animeXYZ" (or a future "/animation") would silently be counted as anime
  // page views.
  test("matches whole segments, not string prefixes", () => {
    expect(surfaceForPath("/animegoclub")).toBe("other");
    expect(surfaceForPath("/searching")).toBe("other");
    expect(surfaceForPath("/libraries")).toBe("other");
  });

  // Every value this can return has to be one the server's allow-list and the
  // activity_surface_daily CHECK constraint accept. A value they do not know
  // is collapsed to "other" server-side, so a drift costs a label rather than
  // a count — but it costs it silently, which is why it is pinned here.
  test("only ever returns allow-listed surfaces", () => {
    const allowed = new Set<string>([
      "home",
      "anime",
      "watch",
      "seasonal",
      "library",
      "community",
      "profile",
      "search",
      "auth",
      "other",
    ]);
    const probes = [
      "/",
      "/anime/1",
      "/player",
      "/seasonal",
      "/calendar",
      "/library",
      "/search",
      "/u/x",
      "/profile",
      "/settings",
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password/t",
      "/welcome",
      "/terms",
      "/en/anime/1",
      "/zh-Hant/library",
      "/../../etc/passwd",
    ];
    for (const probe of probes) {
      expect(allowed.has(surfaceForPath(probe))).toBe(true);
    }
  });
});
