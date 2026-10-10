import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import {
  PRODUCTION_MIRROR_BASE,
  imgSrcs,
  mirrorOf,
  optimizedFrom,
  renderAsNextDev,
  withMirror,
} from "@/lib/test-utils/nextImage";
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

  test("a card is two links, named by the names on it: the character's page and the voice's", () => {
    const grid = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    const links = [...grid.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ["/character/1", "芙莉莲"],
      ["/person/11", "种崎敦美"],
      ["/character/2", "キャラ2"],
      ["/person/21", "小林千晃"],
      // No voice in this dub: the character's link alone.
      ["/character/3", "キャラ3"],
    ]);
  });

  test("a row with no AniList id links nowhere", () => {
    const noIds = render({
      ...FIRST_PAGE,
      data: [character(9, "MAIN", [voice(91, "某声优", { staffId: null })], { characterId: null })],
    });
    const grid = noIds.slice(noIds.indexOf("<ul"), noIds.indexOf("</ul>"));
    expect(grid).not.toContain("<a ");
    expect(cards(noIds)[0]).toContain("キャラ9");
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

  test("one dub is no choice: no switch is drawn, and each card still names its dub", () => {
    // What the API answers now that the credits keep Japanese voices only.
    const html = render({
      ...FIRST_PAGE,
      counts: { ...FIRST_PAGE.counts, languages: [{ language: "ja", count: 98 }] },
    });
    expect(html).not.toContain("配音语言");
    expect(buttons(html).some((b) => b.startsWith("日配"))).toBe(false);
    expect(buttons(html).slice(0, 4)).toEqual(["全部 100", "主角 3", "配角 40", "客串 57"]);
    expect(cards(html)[0]).toContain("日配");
    expect(html).toContain('placeholder="搜角色或声优"');
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

// The portraits, rendered as `next dev` renders them: next/image checks every
// src against the app's remotePatterns and throws on one it does not admit.
// That throw is a 500 for the whole 角色 tab, so "renders at all" is half of
// what these pin; the other half is where each portrait is fetched from.
describe("CharacterBrowser — portraits and the AniList mirror", () => {
  const CHARACTER = "https://s4.anilist.co/file/anilistcdn/character/large/b176754-5x6wfCKhRrxR.png";
  const VOICE = "https://s4.anilist.co/file/anilistcdn/staff/medium/n95991-0B7dPZHaFl9X.png";
  // What the Bangumi V2 worker writes over an AniList portrait.
  const BANGUMI = "https://lain.bgm.tv/pic/crt/l/1a/2b/95991_prsn_aBcDe.jpg?r=1700000000";

  const page = (characterImage: string, voiceImage: string): CharactersResponse => ({
    ...FIRST_PAGE,
    data: [
      character(1, "MAIN", [voice(11, "種﨑敦美", { imageUrl: voiceImage })], {
        nameCn: "芙莉莲",
        imageUrl: characterImage,
      }),
    ],
  });

  const renderDev = (initial: CharactersResponse) =>
    renderAsNextDev(
      <LanguageProvider lang="zh">
        <CharacterBrowser anilistId={154587} initial={initial} />
      </LanguageProvider>,
    );

  test("switched on: both portraits are optimized from our mirror", () => {
    const srcs = withMirror(PRODUCTION_MIRROR_BASE, () => imgSrcs(renderDev(page(CHARACTER, VOICE))));
    expect(srcs).toHaveLength(2);
    expect(srcs[0].startsWith(optimizedFrom(mirrorOf(CHARACTER)))).toBe(true);
    expect(srcs[1].startsWith(optimizedFrom(mirrorOf(VOICE)))).toBe(true);
  });

  test("switched off: the same portraits are optimized from AniList", () => {
    const srcs = withMirror(undefined, () => imgSrcs(renderDev(page(CHARACTER, VOICE))));
    expect(srcs).toHaveLength(2);
    expect(srcs[0].startsWith(optimizedFrom(CHARACTER))).toBe(true);
    expect(srcs[1].startsWith(optimizedFrom(VOICE))).toBe(true);
  });

  test("a row already holding the mirror's URL renders, switch on or off", () => {
    for (const base of [PRODUCTION_MIRROR_BASE, undefined]) {
      const srcs = withMirror(base, () => imgSrcs(renderDev(page(mirrorOf(CHARACTER), mirrorOf(VOICE)))));
      expect(srcs[0].startsWith(optimizedFrom(mirrorOf(CHARACTER)))).toBe(true);
      expect(srcs[1].startsWith(optimizedFrom(mirrorOf(VOICE)))).toBe(true);
    }
  });

  test("a Bangumi portrait stays a plain <img> on Bangumi, switch on or off", () => {
    for (const base of [PRODUCTION_MIRROR_BASE, undefined]) {
      const srcs = withMirror(base, () => imgSrcs(renderDev(page(CHARACTER, BANGUMI))));
      expect(srcs[1]).toBe(BANGUMI);
    }
  });
});
