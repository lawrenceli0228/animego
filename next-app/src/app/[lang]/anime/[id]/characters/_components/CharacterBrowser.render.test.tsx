import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import type { CastCharacter, CharactersResponse } from "@/lib/types";
import CharacterBrowser from "./CharacterBrowser";

// renderToStaticMarkup, as the other render tests here: no jsdom. What it
// pins is the server's first paint of the 角色 tab — the HTML a crawler and a
// cached page carry — from the API's first page: the role chips with their
// counts, a dub button for each dub the title has and none for the others,
// one card per character with the voice and its note, and 「再显示 N 位」 for
// what is left. Filtering and paging after that are the e2e spec's.

const voice = (staffId: number, nameNative: string, extra: Partial<CastCharacter["voices"][number]> = {}) => ({
  staffId,
  nameFull: `Voice ${staffId}`,
  nameNative,
  nameCn: null,
  imageUrl: null,
  roleNotes: null,
  dubGroup: null,
  ...extra,
});

const character = (id: number, role: string, voices: CastCharacter["voices"], extra: Partial<CastCharacter> = {}): CastCharacter => ({
  characterId: id,
  role,
  nameEn: `Character ${id}`,
  nameJa: `キャラ${id}`,
  nameCn: null,
  imageUrl: null,
  voices,
  ...extra,
});

const FIRST_PAGE: CharactersResponse = {
  data: [
    character(1, "MAIN", [voice(11, "種﨑敦美", { nameCn: "种崎敦美" })], { nameCn: "芙莉莲", nameJa: "フリーレン" }),
    character(2, "MAIN", [voice(21, "小林千晃"), voice(22, "清都ありさ", { nameCn: "清都亚里沙", roleNotes: "Childhood" })]),
    character(3, "SUPPORTING", []),
  ],
  total: 100,
  offset: 0,
  limit: 24,
  hasMore: true,
  language: "ja",
  counts: {
    roles: { all: 100, main: 3, supporting: 40, background: 57 },
    languages: [
      { language: "ja", count: 98 },
      { language: "ko", count: 45 },
    ],
  },
};

function render(initial: CharactersResponse, lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <CharacterBrowser anilistId={154587} initial={initial} />
    </LanguageProvider>,
  );
}

/** Text of every button, tags stripped. */
const buttons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));

const cards = (html: string) => [...html.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, "|"));

describe("CharacterBrowser — the first page", () => {
  const html = render(FIRST_PAGE);

  test("role chips carry every role's count; 全部 is pressed", () => {
    expect(buttons(html).slice(0, 4)).toEqual(["全部 100", "主角 3", "配角 40", "客串 57"]);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>全部 /);
  });

  test("a dub button for each dub the title has, none for the others", () => {
    expect(buttons(html)).toContain("日配 98");
    expect(buttons(html)).toContain("韩配 45");
    expect(buttons(html).some((b) => b.startsWith("中配"))).toBe(false);
  });

  test("one card per character, the voice and the line under it", () => {
    const got = cards(html);
    expect(got).toHaveLength(3);
    expect(got[0]).toContain("芙莉莲");
    expect(got[0]).toContain("フリーレン");
    expect(got[0]).toContain("主角");
    expect(got[0]).toContain("种崎敦美");
    expect(got[0]).toContain("種﨑敦美");
    expect(got[0]).toContain("日配");
    expect(got[1]).toContain("童年 · 清都亚里沙");
    // No voice in this dub: the character is still listed, with no voice half.
    expect(got[2]).toContain("キャラ3");
    expect(got[2]).toContain("Character 3");
    expect(got[2]).not.toContain("日配");
  });

  test("「再显示」 names the next page, not the whole remainder", () => {
    expect(buttons(html)).toContain("再显示 48 位");
  });

  test("no card links anywhere: the character and person pages do not exist yet", () => {
    const grid = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    expect(grid).not.toContain("<a ");
  });

  test("a screen reader hears the count, and a portrait is not read as the name beside it", () => {
    expect(html).toMatch(/<p[^>]*aria-live="polite"[^>]*>共 100 位<\/p>/);
    // A host the optimizer does not serve, so FadeImage draws a plain <img>.
    const withPortraits = render({
      ...FIRST_PAGE,
      data: [
        character(1, "MAIN", [voice(11, "種﨑敦美", { imageUrl: "https://img.example/va.jpg" })], {
          imageUrl: "https://img.example/character.jpg",
        }),
      ],
    });
    expect(withPortraits.match(/<img\b/g)).toHaveLength(2);
    expect(withPortraits).not.toMatch(/<img[^>]*alt="[^"]+"/);
  });

  test("the search box is labelled", () => {
    expect(html).toContain('placeholder="搜角色或声优"');
    expect(html).toContain('aria-label="搜角色或声优"');
  });
});

describe("CharacterBrowser — the edges", () => {
  test("everything already shown: no 「再显示」", () => {
    const html = render({ ...FIRST_PAGE, total: 3, hasMore: false });
    expect(buttons(html).some((b) => b.startsWith("再显示"))).toBe(false);
  });

  test("fewer left than a page: the number that is left", () => {
    const html = render({ ...FIRST_PAGE, total: 10 });
    expect(buttons(html)).toContain("再显示 7 位");
  });

  test("a title with no characters says so, and no dub switch is drawn", () => {
    const html = render({
      ...FIRST_PAGE,
      data: [],
      total: 0,
      hasMore: false,
      counts: { roles: { all: 0, main: 0, supporting: 0, background: 0 }, languages: [] },
    });
    expect(html).toContain("这部作品还没有角色资料");
    expect(html).not.toContain("配音语言");
  });

  test("English labels", () => {
    const html = render(FIRST_PAGE, "en");
    expect(buttons(html).slice(0, 4)).toEqual(["All 100", "Main 3", "Supporting 40", "Background 57"]);
    expect(buttons(html)).toContain("Japanese 98");
    expect(buttons(html)).toContain("Show 48 more");
  });
});
