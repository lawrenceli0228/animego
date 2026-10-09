import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import type { StaffCredit } from "@/lib/types";
import StaffBrowser from "./StaffBrowser";

// The server's first paint of the 制作 tab, from the whole credit list the API
// gives: every department in order with its count, a chip for each, people
// as rows with every role they have in the department, the preview cap and
// 「展开全部 N 位」 in the 全部 view, and names only for a department too large
// for rows. The chips and the search after that are the e2e spec's.

const credit = (staffId: number | null, role: string, nameJa: string, nameEn: string): StaffCredit => ({
  staffId,
  role,
  nameJa,
  nameEn,
  nameCn: null,
  imageUrl: null,
});

const CREDITS: StaffCredit[] = [
  credit(1, "Director", "斎藤圭一郎", "Keiichirou Saitou"),
  credit(2, "Original Story", "山田鐘人", "Kanehito Yamada"),
  credit(1, "Storyboard (eps 1, 2)", "斎藤圭一郎", "Keiichirou Saitou"),
  credit(3, "Music", "エバン・コール", "Evan Call"),
  ...Array.from({ length: 12 }, (_, i) => credit(100 + i, "Episode Director", `演出${i + 1}`, `Episode Director ${i + 1}`)),
  ...Array.from({ length: 50 }, (_, i) => credit(200 + i, "Key Animation", `原画${i + 1}`, `Animator ${i + 1}`)),
];

function render(credits: StaffCredit[], lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <StaffBrowser credits={credits} />
    </LanguageProvider>,
  );
}

const strip = (s: string) => s.replace(/<[^>]+>/g, "");
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((m) => strip(m[1]));
const headings = (html: string) => [...html.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/g)].map((m) => strip(m[1]));

/** The <section> of one department, by its heading. */
function department(html: string, name: string): string {
  const at = html.indexOf(`>${name}</h3>`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<section", at);
  return html.slice(start, html.indexOf("</section>", at));
}

const items = (section: string) => [...section.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((m) => strip(m[1]));

describe("StaffBrowser — the first paint", () => {
  const html = render(CREDITS);

  test("departments in the tab's order", () => {
    expect(headings(html)).toEqual(["原作", "监督与演出", "原画与动画", "音乐"]);
  });

  test("a chip per department with its people, and 全部 counting each person once", () => {
    // 1 director + 1 writer + 1 composer + 12 episode directors + 50 animators.
    expect(buttons(html).slice(0, 5)).toEqual(["全部 65", "原作 1", "监督与演出 13", "原画与动画 50", "音乐 1"]);
  });

  test("a person is one row per department with every role there, in the page's labels", () => {
    const direction = items(department(html, "监督与演出"));
    expect(direction[0]).toContain("斎藤圭一郎");
    expect(direction[0]).toContain("Keiichirou Saitou");
    expect(direction[0]).toContain("监督 · 分镜 (eps 1, 2)");
  });

  test("the 全部 view previews nine rows and offers the rest", () => {
    const direction = department(html, "监督与演出");
    expect(items(direction)).toHaveLength(9);
    expect(direction).toContain("展开全部 13 位");
    expect(direction).toContain('aria-expanded="false"');
  });

  test("a department this large lists names only, 36 at first", () => {
    const keyAnimation = department(html, "原画与动画");
    expect(items(keyAnimation)).toHaveLength(36);
    // The name, and its role as text only a screen reader reads (a mouse
    // gets it as the tooltip): there is no role line to see.
    expect(items(keyAnimation)[0]).toBe("原画1 原画");
    expect(keyAnimation).toContain('title="原画"');
    expect(keyAnimation).toContain("展开全部 50 位");
    // Names only: no portrait placeholders, no role lines.
    expect(keyAnimation).not.toContain("原画 · ");
  });

  test("a small department shows everyone and offers nothing", () => {
    const music = department(html, "音乐");
    expect(items(music)).toHaveLength(1);
    expect(music).not.toContain("展开全部");
  });

  test("a screen reader hears how many people the view holds, and the portraits are not read as names", () => {
    expect(html).toMatch(/<p[^>]*aria-live="polite"[^>]*>共 65 位<\/p>/);
    expect(html).not.toMatch(/<img[^>]*alt="[^"]+"/);
  });

  test("every row and every name opens the person's page", () => {
    const hrefs = (section: string) => [...section.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    // One link per person per department, whatever their roles there.
    expect(hrefs(department(html, "监督与演出")).slice(0, 2)).toEqual(["/person/1", "/person/100"]);
    expect(hrefs(department(html, "原作"))).toEqual(["/person/2"]);
    // Names only: each name is the link, with its role still read out.
    const keyAnimation = department(html, "原画与动画");
    expect(hrefs(keyAnimation)).toHaveLength(36);
    expect(hrefs(keyAnimation)[0]).toBe("/person/200");
    expect(keyAnimation).toMatch(/<a\b[^>]*title="原画"[^>]*>原画1/);
  });
});

describe("StaffBrowser — the edges", () => {
  test("a credit with no AniList id is text, in a row or as a name", () => {
    const html = render([
      credit(null, "Director", "某监督", "Some Director"),
      ...Array.from({ length: 40 }, (_, i) => credit(null, "Key Animation", `原画${i + 1}`, `Animator ${i + 1}`)),
    ]);
    expect(html).not.toContain("<a ");
    expect(items(department(html, "监督与演出"))[0]).toContain("某监督");
    expect(items(department(html, "原画与动画"))[0]).toBe("原画1 原画");
  });

  test("no staff at all says so, with no chips and no search", () => {
    const html = render([]);
    expect(html).toContain("这部作品还没有制作人员资料");
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain("<input");
  });

  test("English: the English name leads, the role is AniList's", () => {
    const html = render(CREDITS, "en");
    expect(headings(html)[1]).toBe("Direction");
    const direction = items(department(html, "Direction"));
    // The row starts with the empty portrait's initial; then the name, then the other one.
    expect(direction[0].indexOf("Keiichirou Saitou")).toBeLessThan(direction[0].indexOf("斎藤圭一郎"));
    expect(direction[0]).toContain("Director · Storyboard (eps 1, 2)");
    expect(buttons(html)[0]).toBe("All 65");
  });
});
