import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Dict } from "@/lib/i18n";
import zh from "@/locales/zh";
import en from "@/locales/en";
import zhHant from "@/locales/zh-Hant";
import DetailTabs from "./DetailTabs";

// The tab bar every /anime/[id] tab renders: three links, the active one
// marked for assistive tech and for the stylesheet, and the counts the API
// gave — or no count at all when it gave none, never a "0" made up for it.
//
// The dictionaries are imported directly rather than through getDictByLang:
// bun runs every test file in one process, and admin/_actions/users.test.ts
// replaces @/lib/i18n with a stub for the rest of the run.

/** Every link in the bar as [href, text, aria-current]. */
function links(html: string): Array<[string, string, string | null]> {
  return [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => [
    /href="([^"]+)"/.exec(m[1])?.[1] ?? "",
    m[2].replace(/<[^>]+>/g, ""),
    /aria-current="([^"]+)"/.exec(m[1])?.[1] ?? null,
  ]);
}

describe("DetailTabs", () => {
  test("three tabs, each a route, the active one marked", () => {
    const html = renderToStaticMarkup(
      <DetailTabs anilistId={154587} active="characters" counts={{ characters: 100, staff: 343 }} dict={zh} />,
    );
    expect(links(html)).toEqual([
      ["/anime/154587", "概览", null],
      ["/anime/154587/characters", "角色 100", "page"],
      ["/anime/154587/staff", "制作 343", null],
    ]);
    expect(html).toContain('aria-label="作品页标签"');
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
  });

  test("no count is printed when the counts did not arrive", () => {
    const html = renderToStaticMarkup(<DetailTabs anilistId={1} active="overview" counts={{}} dict={zh} />);
    expect(links(html).map(([, text]) => text)).toEqual(["概览", "角色", "制作"]);
    expect(links(html)[0][2]).toBe("page");
  });

  test("a zero is a count", () => {
    const html = renderToStaticMarkup(
      <DetailTabs anilistId={1} active="staff" counts={{ characters: 0, staff: 0 }} dict={zh} />,
    );
    expect(links(html).map(([, text]) => text)).toEqual(["概览", "角色 0", "制作 0"]);
  });

  test("names follow the page's language", () => {
    const html = renderToStaticMarkup(
      <DetailTabs anilistId={1} active="overview" counts={{ characters: 3, staff: 4 }} dict={en as unknown as Dict} />,
    );
    expect(links(html).map(([, text]) => text)).toEqual(["Overview", "Characters 3", "Staff 4"]);
    const hant = renderToStaticMarkup(
      <DetailTabs anilistId={1} active="overview" counts={{}} dict={zhHant} />,
    );
    expect(links(hant).map(([, text]) => text)).toEqual(["概覽", "角色", "製作"]);
  });
});
