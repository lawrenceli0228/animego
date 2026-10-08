import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { getDictByLang } from "@/lib/i18n";
import { LANGS, type Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import type { Character, PeopleWork, Person, VoiceRole, VoiceYear } from "@/lib/people/types";
import CharacterView from "./CharacterView";
import PersonView from "./PersonView";

// renderToStaticMarkup, as the repo's other render tests: no DOM. This pins
// what the server sends — the first view of every list, the links, the
// collapsed spoilers — which is what a crawler reads and what a reader sees
// before anything hydrates. The controls' behaviour (the filter, 查看全部, a
// spoiler opening) is the pure logic in lib/people/*.test.ts and, in a
// browser, e2e/specs/sandbox/people-pages.spec.ts.

function work(id: number, year: number | null, extra: Partial<PeopleWork> = {}): PeopleWork {
  return {
    anilistId: id,
    titleRomaji: `Show ${id}`,
    titleEnglish: `Show ${id} (EN)`,
    titleNative: null,
    titleChinese: `番剧${id}`,
    titleHant: null,
    titleHantSeo: null,
    coverImageUrl: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/${id}.jpg`,
    format: "TV",
    year,
    popularity: 1000,
    posterAccent: "#7caf62",
    ...extra,
  };
}

function voiceRole(animeId: number, year: number | null, characterId: number, role: string): VoiceRole {
  return {
    character: {
      anilistId: characterId,
      name: { full: `Char ${characterId}`, native: `キャラ${characterId}`, cn: `角色${characterId}` },
      image: `https://s4.anilist.co/file/anilistcdn/character/large/b${characterId}.png`,
    },
    anime: work(animeId, year),
    role,
    language: "Japanese",
    roleNotes: null,
  };
}

const FRIEREN = work(154587, 2023, { titleChinese: "葬送的芙莉莲", popularity: 480000 });

const STARK: Character = {
  anilistId: 184313,
  bangumiId: 89182,
  name: { full: "Stark", native: "シュタルク", cn: "修塔尔克" },
  alternativeNames: ["休塔尔克"],
  image: "https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg",
  profile: {
    description:
      "Stark fights alongside [Frieren](https://anilist.co/character/176754/Frieren).\n\n~!He becomes a hero later.!~ The end.",
    gender: "Male",
    age: "17-18",
    birth: null,
    bloodType: null,
    siteUrl: "https://anilist.co/character/184313",
  },
  voices: [
    {
      person: { anilistId: 133507, name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" }, image: null },
      language: "Japanese",
      roleNotes: null,
    },
    {
      person: { anilistId: 115100, name: { full: "Arisa Kiyoto", native: "清都ありさ", cn: "清都亚里沙" }, image: null },
      language: "Japanese",
      roleNotes: "Childhood",
    },
  ],
  appearances: [
    { anime: FRIEREN, role: "MAIN" },
    { anime: work(182255, 2026, { titleChinese: "葬送的芙莉莲 第二季" }), role: "MAIN" },
  ],
  indexable: true,
};

function renderCharacter(character: Character, lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <CharacterView character={character} lang={lang} dict={getDictByLang(lang)} />
    </LanguageProvider>,
  );
}

/** Ten years of five roles each, newest first, every third a lead. */
function longCareer(): VoiceYear[] {
  const years: VoiceYear[] = [];
  let n = 0;
  for (let y = 2026; y > 2016; y--) {
    const roles: VoiceRole[] = [];
    for (let i = 0; i < 5; i++, n++) roles.push(voiceRole(10_000 + n, y, 20_000 + n, n % 3 === 0 ? "MAIN" : "SUPPORTING"));
    years.push({ year: y, roles });
  }
  return years;
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    anilistId: 133507,
    bangumiId: 32265,
    name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" },
    image: null,
    profile: {
      occupations: ["Voice Actor"],
      gender: "Male",
      birth: { year: 1994, month: 6, day: 4 },
      death: null,
      age: 32,
      yearsActive: [],
      homeTown: "Kanagawa Prefecture, Japan",
      bloodType: null,
      language: "Japanese",
      siteUrl: "https://anilist.co/staff/133507",
    },
    representativeRoles: [{ ...voiceRole(154587, 2023, 184313, "MAIN"), anime: FRIEREN }],
    voiceRoles: [
      { year: null, roles: [voiceRole(190001, null, 1, "SUPPORTING")] },
      { year: 2023, roles: [{ ...voiceRole(154587, 2023, 184313, "MAIN"), anime: FRIEREN }] },
    ],
    staffRoles: [],
    voiceWorkCount: 2,
    staffWorkCount: 0,
    indexable: false,
    ...overrides,
  };
}

function renderPerson(p: Person, lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <PersonView person={p} lang={lang} dict={getDictByLang(lang)} />
    </LanguageProvider>,
  );
}

const count = (html: string, needle: string | RegExp) =>
  typeof needle === "string" ? html.split(needle).length - 1 : (html.match(needle) ?? []).length;

describe("the character page", () => {
  const html = renderCharacter(STARK);

  test("names: the Chinese one as the heading, the native and romanised under it, the alias", () => {
    expect(html).toContain(">修塔尔克</h1>");
    expect(html).toContain("シュタルク");
    expect(html).toContain("Stark");
    expect(html).toContain("休塔尔克");
  });

  test("the spoiler is a collapsed button, never the markup and never the hidden text", () => {
    expect(html).not.toContain("~!");
    expect(html).not.toContain("!~");
    expect(html).not.toContain("He becomes a hero later");
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>剧透<\/button>/);
    // The text around it, and the link reduced to its words.
    expect(html).toContain("Stark fights alongside Frieren.");
    expect(html).toContain("The end.");
    expect(html).not.toContain("anilist.co/character/176754");
    // AniList writes it in English, and the page says so.
    expect(html).toMatch(/<div[^>]*lang="en"/);
  });

  test("facts, with an em dash for what is not known", () => {
    expect(html).toMatch(/性别<\/dt><dd[^>]*>男<\/dd>/);
    expect(html).toMatch(/年龄<\/dt><dd[^>]*>17-18<\/dd>/);
    expect(html).toMatch(/生日<\/dt><dd[^>]*>—<\/dd>/);
    expect(html).toMatch(/血型<\/dt><dd[^>]*>—<\/dd>/);
  });

  test("every voice, with its language and note, links to the person", () => {
    expect(html).toContain('href="/person/133507"');
    expect(html).toContain('href="/person/115100"');
    expect(html).toContain("日配 · 童年");
  });

  test("titles link to the anime, with the role and format · year", () => {
    expect(count(html, 'href="/anime/154587"')).toBeGreaterThanOrEqual(1);
    expect(html).toContain('href="/anime/182255"');
    expect(html).toContain("TV · 2023");
    expect(html).toContain(">主角</span>");
  });

  test("the breadcrumb: the title it hangs under, that title's cast, the character", () => {
    const nav = /<nav aria-label="位置">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect(nav).toContain('href="/anime/154587"');
    expect(nav).toContain('href="/anime/154587/characters"');
    expect(nav).toContain('aria-current="page">修塔尔克<');
  });

  test("no edit button yet, and no notes on where the data came from", () => {
    expect(html).not.toContain("编辑");
    expect(html).not.toContain("资料来自");
    expect(html).not.toContain("数据来自");
  });

  test("the page takes its colour from the title it hangs under", () => {
    expect(html).toMatch(/<main class="container poster-scope [^"]*" style="--poster-hue:\d/);
  });

  test("without a profile: no facts grid, no description", () => {
    const bare = renderCharacter({ ...STARK, profile: null });
    expect(bare).not.toContain("<dl");
    expect(bare).not.toContain("剧透");
    expect(bare).toContain(">修塔尔克</h1>");
  });

  test("a description with no text in it gets no 简介 section", () => {
    const html = renderCharacter({ ...STARK, profile: { ...STARK.profile!, description: "img220(https://x/y.png)" } });
    expect(html).not.toContain("profile-about");
  });

  test("every language renders its own labels", () => {
    expect(renderCharacter(STARK, "en")).toContain(">Stark</h1>");
    expect(renderCharacter(STARK, "en")).toContain("Japanese · Childhood");
    expect(renderCharacter(STARK, "zh-Hant")).toContain(">聲優<");
    for (const lang of LANGS) {
      // A dictionary key the client side lacks renders as the key itself.
      expect(renderCharacter(STARK, lang)).not.toContain("people.");
    }
  });
});

describe("the person page", () => {
  test("header: one name where the Chinese and the native are the same string, the occupation, the facts", () => {
    const html = renderPerson(person());
    expect(html).toContain(">小林千晃</h1>");
    expect(count(html, ">小林千晃<")).toBe(2); // the heading and the breadcrumb
    expect(html).toContain("Chiaki Kobayashi");
    expect(html).toContain(">声优</span>");
    expect(html).toMatch(/生日<\/dt><dd[^>]*>1994年6月4日<\/dd>/);
    expect(html).toMatch(/出身地<\/dt><dd[^>]*>神奈川县<\/dd>/);
  });

  test("representative roles link the character and the title", () => {
    const html = renderPerson(person());
    const rep = /aria-labelledby="representative-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(rep).toContain('href="/character/184313"');
    expect(rep).toContain('href="/anime/154587"');
    expect(rep).toContain("葬送的芙莉莲");
    expect(rep).toContain(" · 主角");
  });

  test("the voice timeline: years newest first, the undated on top, each card two links", () => {
    const html = renderPerson(person());
    const timeline = /aria-labelledby="voice-roles-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(timeline.indexOf(">待定</h3>")).toBeLessThan(timeline.indexOf(">2023</h3>"));
    expect(timeline).toContain("本站收录 <span");
    expect(timeline).toContain('href="/character/184313"');
    expect(timeline).toContain('href="/anime/154587"');
  });

  test("新到旧 / 只看主角 only where they would change something", () => {
    expect(renderPerson(person())).toContain('aria-pressed="true"');
    const leadsOnly = person({
      voiceRoles: [{ year: 2023, roles: [{ ...voiceRole(154587, 2023, 184313, "MAIN"), anime: FRIEREN }] }],
      voiceWorkCount: 1,
    });
    expect(renderPerson(leadsOnly)).not.toContain("aria-pressed");
  });

  test("a long career shows 21 cards and 查看全部 with the number of titles", () => {
    const html = renderPerson(person({ voiceRoles: longCareer(), voiceWorkCount: 50 }));
    const timeline = /aria-labelledby="voice-roles-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    // Two links per card (the portrait and the name), one character each.
    expect(new Set(timeline.match(/href="\/character\/2\d{4}"/g)).size).toBe(21);
    expect(timeline).toContain(">查看全部 50 部</button>");
    // Five a year: 2026..2023 whole, 2022 its first card, nothing older.
    expect(timeline).toContain(">2022</h3>");
    expect(timeline).not.toContain(">2021</h3>");
  });

  test("production staff get 制作作品, with each title's roles translated", () => {
    const staff = person({
      representativeRoles: [],
      voiceRoles: [],
      voiceWorkCount: 0,
      staffWorkCount: 1,
      profile: null,
      staffRoles: [{ year: 2023, works: [{ anime: FRIEREN, roles: ["Director", "Storyboard (eps 1, 5)"] }] }],
    });
    const html = renderPerson(staff);
    expect(html).toContain(">制作作品</h2>");
    expect(html).not.toContain(">配音作品</h2>");
    expect(html).toContain('href="/anime/154587"');
    // The site's staff-role table (contentLabels): 监督, as the detail page says it.
    expect(html).toContain("监督 · 分镜 (eps 1, 5)");
    // The breadcrumb goes to the title's staff list.
    expect(html).toContain('href="/anime/154587/staff"');
    // No profile, no voices: no facts grid and no tag.
    expect(html).not.toContain("<dl");
    expect(html).not.toContain(">声优</span>");
  });

  test("a voice actor the sweep has not reached is still tagged a voice actor", () => {
    expect(renderPerson(person({ profile: null }))).toContain(">声优</span>");
  });

  test("no edit button, no source notes", () => {
    const html = renderPerson(person());
    expect(html).not.toContain("编辑");
    expect(html).not.toContain("资料来自");
  });
});
