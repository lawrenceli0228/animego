import { describe, expect, test } from "bun:test";

import { getDictByLang } from "@/lib/i18n";
import {
  breadcrumbJsonLd,
  characterBreadcrumbSteps,
  characterMetaDescription,
  characterMetaTitle,
  personBreadcrumbSteps,
  personJsonLd,
  personMetaDescription,
  personMetaTitle,
} from "./seo";
import { primaryAppearance } from "./primary";
import { characterFacts, hueStyle, nativeLanguage, personFacts, personTags } from "./view";
import type { Character, PeopleWork, Person } from "./types";

const zh = getDictByLang("zh");
const en = getDictByLang("en");
const hant = getDictByLang("zh-Hant");

function work(id: number, extra: Partial<PeopleWork> = {}): PeopleWork {
  return {
    anilistId: id,
    titleRomaji: "Sousou no Frieren",
    titleEnglish: "Frieren: Beyond Journey's End",
    titleNative: "葬送のフリーレン",
    titleChinese: "葬送的芙莉莲",
    titleHant: "葬送的芙莉蓮",
    titleHantSeo: null,
    coverImageUrl: null,
    format: "TV",
    year: 2023,
    popularity: 480000,
    posterAccent: "#7caf62",
    ...extra,
  };
}

const HANAZAWA: Person = {
  anilistId: 95185,
  bangumiId: 4893,
  name: { full: "Kana Hanazawa", native: "花澤香菜", cn: "花泽香菜" },
  image: "https://s4.anilist.co/file/anilistcdn/staff/large/n95185.jpg",
  profile: {
    occupations: ["Voice Actor", "Singer"],
    gender: "Female",
    birth: { year: 1989, month: 2, day: 25 },
    death: null,
    age: 37,
    yearsActive: [2003],
    homeTown: "Tokyo, Japan",
    bloodType: "A",
    language: "Japanese",
    siteUrl: "https://anilist.co/staff/95185",
  },
  representativeRoles: [
    {
      character: { anilistId: 1, name: { full: "Akane", native: "茜", cn: "茜" }, image: null },
      anime: work(10, { titleChinese: "番剧甲" }),
      role: "MAIN",
      language: "Japanese",
      roleNotes: null,
    },
    {
      character: { anilistId: 2, name: { full: "Nadeko", native: "撫子", cn: "抚子" }, image: null },
      anime: work(11, { titleChinese: "番剧乙" }),
      role: "MAIN",
      language: "Japanese",
      roleNotes: null,
    },
  ],
  voiceRoles: [],
  staffRoles: [],
  voiceWorkCount: 524,
  staffWorkCount: 3,

  indexable: true,
};

const STARK: Character = {
  anilistId: 184313,
  bangumiId: 89182,
  name: { full: "Stark", native: "シュタルク", cn: "修塔尔克" },
  alternativeNames: [],
  image: null,
  profile: null,
  voices: [
    { key: "133507|Japanese|", person: { anilistId: 133507, name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" }, image: null }, language: "Japanese", roleNotes: null, line: null },
    { key: "133507|Japanese|Young", person: { anilistId: 133507, name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" }, image: null }, language: "Japanese", roleNotes: "Young", line: null },
  ],
  appearances: [
    { anime: work(154587), role: "MAIN" },
    { anime: work(182255, { titleChinese: "葬送的芙莉莲 第二季", popularity: 100 }), role: "MAIN" },
  ],
  bangumiDescription: null,

  indexable: true,
};

describe("person titles and descriptions", () => {
  test("the native name beside the Chinese one when they differ, and what the person is", () => {
    expect(personMetaTitle(HANAZAWA, "zh", zh)).toBe("花泽香菜（花澤香菜） · 声优 · AnimeGoClub");
    expect(personMetaTitle(HANAZAWA, "en", en)).toBe("Kana Hanazawa (花澤香菜) · Voice actor · AnimeGoClub");
    const same = { ...HANAZAWA, name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" } };
    expect(personMetaTitle(same, "zh", zh)).toBe("小林千晃 · 声优 · AnimeGoClub");
    expect(personMetaTitle({ ...HANAZAWA, voiceWorkCount: 0 }, "zh", zh)).toContain(" · 制作人员 · ");
  });

  test("the description is written from the page's facts", () => {
    expect(personMetaDescription(HANAZAWA, "zh", zh)).toBe(
      "花泽香菜，声优。代表角色：茜（番剧甲）、抚子（番剧乙）。本站收录 524 部配音作品。",
    );
    expect(personMetaDescription(HANAZAWA, "en", en)).toBe(
      "Kana Hanazawa — Voice actor. Known for Akane (Frieren: Beyond Journey's End), Nadeko (Frieren: Beyond Journey's End). Voiced titles on AnimeGoClub: 524.",
    );
    const staffOnly = { ...HANAZAWA, voiceWorkCount: 0, representativeRoles: [] };
    expect(personMetaDescription(staffOnly, "zh", zh)).toBe("花泽香菜，制作人员。本站收录 3 部制作作品。");
  });
});

describe("character titles and descriptions", () => {
  const primary = primaryAppearance(STARK);

  test("named with the title it hangs under", () => {
    expect(characterMetaTitle(STARK, primary, "zh", zh)).toBe("修塔尔克（シュタルク） · 葬送的芙莉莲 · AnimeGoClub");
    expect(characterMetaTitle(STARK, primary, "en", en)).toBe(
      "Stark (シュタルク) · Frieren: Beyond Journey's End · AnimeGoClub",
    );
  });

  test("zh-Hant search surfaces read the SEO-safe title, not a converted one", () => {
    // titleHantSeo is null (the Traditional title came out of a converter),
    // so the Simplified title stands in for it.
    expect(characterMetaTitle(STARK, primary, "zh-Hant", hant)).toContain(" · 葬送的芙莉莲 · ");
  });

  test("role, voices (each person once), and the number of titles", () => {
    expect(characterMetaDescription(STARK, primary, "zh", zh)).toBe(
      "修塔尔克，《葬送的芙莉莲》主角。声优：小林千晃。出演 2 部作品。",
    );
    expect(characterMetaDescription(STARK, primary, "en", en)).toBe(
      "Stark from Frieren: Beyond Journey's End. Voiced by Chiaki Kobayashi. Appearances: 2.",
    );
  });
});

describe("JSON-LD", () => {
  test("a Person with what the page shows and its AniList and Bangumi pages as sameAs", () => {
    const ld = personJsonLd(HANAZAWA, "zh", "zh-Hans");
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "Person",
      name: "花泽香菜",
      url: "https://animegoclub.com/person/95185",
      alternateName: ["花澤香菜", "Kana Hanazawa"],
      image: "https://s4.anilist.co/file/anilistcdn/staff/large/n95185.jpg",
      birthDate: "1989-02-25",
      gender: "Female",
      jobTitle: ["Voice Actor", "Singer"],
      sameAs: ["https://anilist.co/staff/95185", "https://bgm.tv/person/4893"],
    });
    expect(personJsonLd(HANAZAWA, "en", "en").url).toBe("https://animegoclub.com/en/person/95185");
  });

  test("fields AniList does not have are absent, not empty", () => {
    const ld = personJsonLd({ ...HANAZAWA, profile: null, bangumiId: null, image: null }, "zh", "zh-Hans");
    expect(Object.keys(ld).sort()).toEqual(["@context", "@type", "alternateName", "name", "url"]);
    const birthdayOnly = personJsonLd(
      { ...HANAZAWA, profile: { ...HANAZAWA.profile!, birth: { year: null, month: 2, day: 25 }, gender: "Non-binary" } },
      "zh",
      "zh-Hans",
    );
    expect(birthdayOnly.birthDate).toBeUndefined();
    expect(birthdayOnly.gender).toBeUndefined();
  });

  test("breadcrumbs: home, the title, its list, the page (no URL on the page itself)", () => {
    const ld = breadcrumbJsonLd(characterBreadcrumbSteps(STARK, "zh", zh), "zh-Hans");
    expect(ld.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: zh.nav.home, item: "https://animegoclub.com/" },
      { "@type": "ListItem", position: 2, name: "葬送的芙莉莲", item: "https://animegoclub.com/anime/154587" },
      { "@type": "ListItem", position: 3, name: "角色", item: "https://animegoclub.com/anime/154587/characters" },
      { "@type": "ListItem", position: 4, name: "修塔尔克" },
    ]);
    const person = personBreadcrumbSteps(HANAZAWA, "en", en);
    expect(person.map((s) => s.name)).toEqual([en.nav.home, "Frieren: Beyond Journey's End", "Characters", "Kana Hanazawa"]);
  });
});

describe("view helpers", () => {
  test("person facts in the canvas's order, 忌日 only when there is one", () => {
    expect(personFacts(HANAZAWA.profile, "zh", zh)).toEqual([
      { label: "生日", value: "1989年2月25日" },
      { label: "性别", value: "女" },
      { label: "出身地", value: "东京都" },
      { label: "血型", value: "A型" },
    ]);
    const died = personFacts({ ...HANAZAWA.profile!, death: { year: 2024, month: 8, day: 20 } }, "zh", zh);
    expect(died?.at(-1)).toEqual({ label: "忌日", value: "2024年8月20日" });
    expect(personFacts(null, "zh", zh)).toBeUndefined();
  });

  test("character facts", () => {
    expect(
      characterFacts(
        { description: null, gender: "Male", age: " 17-18 ", birth: { year: null, month: 3, day: 1 }, bloodType: null, siteUrl: null },
        "zh",
        zh,
      ),
    ).toEqual([
      { label: "性别", value: "男" },
      { label: "年龄", value: "17-18" },
      { label: "生日", value: "3月1日" },
      { label: "血型", value: null },
    ]);
  });

  test("tags: the occupations, else 声优 for anyone credited with a voice", () => {
    expect(personTags(HANAZAWA, "zh")).toEqual(["声优", "歌手"]);
    expect(personTags({ profile: null, voiceWorkCount: 2 }, "zh")).toEqual(["声优"]);
    expect(personTags({ profile: null, voiceWorkCount: 0 }, "zh")).toEqual([]);
  });

  test("the native name's language", () => {
    expect(nativeLanguage("小林千晃", "Japanese")).toBe("ja");
    expect(nativeLanguage("阿杰", "Chinese")).toBe("zh");
    expect(nativeLanguage("シュタルク")).toBe("ja");
    expect(nativeLanguage("김신우")).toBe("ko");
    expect(nativeLanguage("魏无羡")).toBeNull();
    expect(nativeLanguage(null)).toBeNull();
  });

  test("the page colour is the hue of the title's accent, or none for a grey one", () => {
    expect(hueStyle("#7caf62")).toEqual({ "--poster-hue": expect.stringMatching(/^\d+\.\d$/) } as never);
    expect(hueStyle("#808080")).toBeUndefined();
    expect(hueStyle(null)).toBeUndefined();
  });
});
