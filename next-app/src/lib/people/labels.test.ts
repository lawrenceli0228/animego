import { describe, expect, test } from "bun:test";

import {
  bloodTypeLabel,
  characterRoleLabel,
  dubLanguageLabel,
  genderLabel,
  homeTownLabel,
  occupationLabels,
  roleNotesLabel,
  voiceLine,
} from "./labels";

describe("character roles", () => {
  test("the detail page's three words", () => {
    expect(characterRoleLabel("MAIN", "zh")).toBe("主角");
    expect(characterRoleLabel("SUPPORTING", "zh-Hant")).toBe("配角");
    expect(characterRoleLabel("BACKGROUND", "en")).toBe("Background");
    expect(characterRoleLabel(null, "zh")).toBeNull();
    expect(characterRoleLabel("CAMEO", "zh")).toBe("CAMEO");
  });
});

describe("voices", () => {
  test("a dub is named by its language", () => {
    expect(dubLanguageLabel("Japanese", "zh")).toBe("日配");
    expect(dubLanguageLabel("Korean", "zh-Hant")).toBe("韓配");
    expect(dubLanguageLabel("Korean", "en")).toBe("Korean");
    expect(dubLanguageLabel("Hebrew", "zh")).toBe("Hebrew");
    expect(dubLanguageLabel(null, "zh")).toBeNull();
  });

  test("role notes: known words and episode ranges translate, the rest stays", () => {
    expect(roleNotesLabel("Childhood", "zh")).toBe("童年");
    expect(roleNotesLabel("Young", "zh-Hant")).toBe("幼年");
    expect(roleNotesLabel("eps 440-", "zh")).toBe("第 440 集起");
    expect(roleNotesLabel("ep 511", "zh")).toBe("第 511 集");
    expect(roleNotesLabel("eps 233-1122", "zh")).toBe("第 233–1122 集");
    expect(roleNotesLabel("eps 103, 104", "zh")).toBe("第 103、104 集");
    expect(roleNotesLabel("Adult; eps 1116-", "zh")).toBe("成年 · 第 1116 集起");
    expect(roleNotesLabel("True Self", "zh")).toBe("True Self");
    expect(roleNotesLabel("Adult; eps 1116-", "en")).toBe("Adult · eps 1116-");
    expect(roleNotesLabel("  ", "zh")).toBeNull();
  });

  test("the line under a voice: language, then notes", () => {
    expect(voiceLine("Japanese", "Childhood", "zh")).toBe("日配 · 童年");
    expect(voiceLine("Japanese", null, "zh")).toBe("日配");
    expect(voiceLine(null, null, "zh")).toBe("");
  });
});

describe("profile facts", () => {
  test("gender", () => {
    expect(genderLabel("Male", "zh")).toBe("男");
    expect(genderLabel("Female", "zh-Hant")).toBe("女");
    expect(genderLabel("Male", "en")).toBe("Male");
    expect(genderLabel("Genderfluid", "zh")).toBe("Genderfluid");
    expect(genderLabel(null, "zh")).toBeNull();
  });

  test("blood type", () => {
    expect(bloodTypeLabel("A", "zh")).toBe("A型");
    expect(bloodTypeLabel("ab", "zh-Hant")).toBe("AB型");
    expect(bloodTypeLabel("O+", "zh")).toBe("O+型");
    expect(bloodTypeLabel("B", "en")).toBe("B");
    expect(bloodTypeLabel("unknown", "zh")).toBe("unknown");
    expect(bloodTypeLabel("", "zh")).toBeNull();
  });

  test("occupations: translated, deduplicated, AniList's text otherwise", () => {
    expect(occupationLabels(["Voice Actor", "Vocalist"], "zh")).toEqual(["声优", "歌手"]);
    expect(occupationLabels(["Actor", "Actress", "Singer"], "zh")).toEqual(["演员", "歌手"]);
    expect(occupationLabels(["Voice Actor"], "zh-Hant")).toEqual(["聲優"]);
    expect(occupationLabels(["Voice Actor", " "], "en")).toEqual(["Voice Actor"]);
    expect(occupationLabels(["Puppeteer"], "zh")).toEqual(["Puppeteer"]);
  });

  test("home town: the prefecture in Chinese, however AniList spells it", () => {
    expect(homeTownLabel("Kanagawa Prefecture, Japan", "zh")).toBe("神奈川县");
    expect(homeTownLabel("Houfu, Yamaguchi Prefecture, Japan", "zh")).toBe("山口县");
    expect(homeTownLabel("Tokyo, Japan", "zh-Hant")).toBe("東京都");
    expect(homeTownLabel("Hyōgo Prefecture, Japan", "zh")).toBe("兵库县");
    expect(homeTownLabel("Ooita, Japan", "zh")).toBe("大分县");
    expect(homeTownLabel("Kouchi Prefecture, Japan", "zh")).toBe("高知县");
    // A country the table knows, with a region it does not: the country.
    expect(homeTownLabel("Hunan, China", "zh")).toBe("中国");
    expect(homeTownLabel("Seoul, South Korea", "zh-Hant")).toBe("韓國");
    // Nothing recognised: as written.
    expect(homeTownLabel("Somewhere, Atlantis", "zh")).toBe("Somewhere, Atlantis");
    // English keeps AniList's text.
    expect(homeTownLabel("Kanagawa Prefecture, Japan", "en")).toBe("Kanagawa Prefecture, Japan");
    expect(homeTownLabel(null, "zh")).toBeNull();
  });
});
