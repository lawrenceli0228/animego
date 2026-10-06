import { describe, expect, test } from "bun:test";
import { FILTER_GENRES } from "@/lib/contentLabels";
import { genreFromSlug } from "@/lib/hubs/paths";
import { genreNavItems, isCurrent, navEntries, type NavEntry } from "./navLinks";

// What the header links to, in which order, and when each one reads as "you
// are here". The order and the auth rule are product decisions; the rest is
// the matching that the old bar got wrong for a whole locale (it compared the
// raw pathname, so nothing was ever current under /en).

const SEASON = "/seasonal/fall/2026";
const keys = (entries: NavEntry[]) => entries.map((e) => e.key);

describe("navEntries", () => {
  test("a visitor gets the five public links, in the agreed order", () => {
    expect(keys(navEntries("anonymous", SEASON))).toEqual([
      "home",
      "schedule",
      "season",
      "genres",
      "about",
    ]);
  });

  test("a signed-in reader gets 我的追番 just before 关于", () => {
    const entries = navEntries("authed", SEASON);
    expect(keys(entries)).toEqual(["home", "schedule", "season", "genres", "myList", "about"]);
    expect(entries.find((e) => e.key === "myList")).toMatchObject({
      href: "/profile",
      placeholder: false,
    });
  });

  test("while the session probe is in flight, 我的追番 is a same-width placeholder, never a link", () => {
    // Probing is only entered when the auth_hint cookie says a session is
    // likely, so the real link is about to arrive and its width is reserved
    // to stop the strip from jumping. It must not be a live link: /profile is
    // gated, and showing a signed-in affordance before the probe answers is
    // the phantom-login mistake the avatar skeleton exists to avoid.
    const myList = navEntries("probing", SEASON).find((e) => e.key === "myList");
    expect(myList?.placeholder).toBe(true);
  });

  test("a visitor gets no placeholder at all — an empty gap is not a stable layout", () => {
    expect(navEntries("anonymous", SEASON).some((e) => e.placeholder)).toBe(false);
  });

  test("the season link points at the live season it was given", () => {
    expect(navEntries("anonymous", SEASON).find((e) => e.key === "season")?.href).toBe(SEASON);
  });

  test("/library is not a top-level link in any state (it lives in the account menu)", () => {
    for (const chrome of ["anonymous", "probing", "authed"] as const) {
      expect(navEntries(chrome, SEASON).some((e) => e.href.startsWith("/library"))).toBe(false);
    }
  });

  test("分类 is a menu, everything else is a link", () => {
    const entries = navEntries("authed", SEASON);
    expect(entries.filter((e) => e.kind === "menu").map((e) => e.key)).toEqual(["genres"]);
  });
});

describe("isCurrent", () => {
  const entry = (key: NavEntry["key"]) =>
    navEntries("authed", SEASON).find((e) => e.key === key) as NavEntry;

  test("home is current only on the root, in every locale", () => {
    expect(isCurrent("/", entry("home"))).toBe(true);
    expect(isCurrent("/en", entry("home"))).toBe(true);
    expect(isCurrent("/zh-Hant", entry("home"))).toBe(true);
    expect(isCurrent("/calendar", entry("home"))).toBe(false);
  });

  test("a section is current on its own path and below it, locale prefix or not", () => {
    expect(isCurrent("/calendar", entry("schedule"))).toBe(true);
    expect(isCurrent("/en/calendar", entry("schedule"))).toBe(true);
    expect(isCurrent("/zh-Hant/welcome", entry("about"))).toBe(true);
    expect(isCurrent("/profile", entry("myList"))).toBe(true);
  });

  test("季度 is current on any season, not just the live one", () => {
    expect(isCurrent("/seasonal/summer/2026", entry("season"))).toBe(true);
    expect(isCurrent("/en/seasonal/winter/2024", entry("season"))).toBe(true);
  });

  test("分类 is current on every genre hub", () => {
    expect(isCurrent("/genre/action", entry("genres"))).toBe(true);
    expect(isCurrent("/en/genre/slice-of-life", entry("genres"))).toBe(true);
    expect(isCurrent("/search", entry("genres"))).toBe(false);
  });

  test("a prefix only counts at a path boundary", () => {
    // "/calendarx" is not the calendar; "/welcome-back" is not 关于.
    expect(isCurrent("/calendarx", entry("schedule"))).toBe(false);
    expect(isCurrent("/welcome-back", entry("about"))).toBe(false);
  });
});

describe("genreNavItems", () => {
  test("lists every browsable genre, in the filter order, each pointing at its hub", () => {
    const items = genreNavItems("zh");
    expect(items.map((i) => i.genre)).toEqual([...FILTER_GENRES]);
    for (const item of items) {
      // The dropdown IS the genre index — there is no index page — so every
      // href has to resolve to a hub the router will actually serve.
      expect(genreFromSlug(item.href.replace(/^\/genre\//, ""))).toBe(item.genre);
    }
  });

  test("labels follow the reader's language", () => {
    const pick = (lang: "zh" | "en" | "zh-Hant") =>
      genreNavItems(lang).find((i) => i.genre === "Slice of Life")?.label;
    expect(pick("zh")).toBe("日常");
    expect(pick("en")).toBe("Slice of Life");
    expect(genreNavItems("zh-Hant").find((i) => i.genre === "Action")?.label).toBe("動作");
  });

  test("the adult genre is not offered", () => {
    expect(genreNavItems("zh").some((i) => i.genre === ("Hentai" as string))).toBe(false);
  });
});
