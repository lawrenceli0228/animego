import { describe, expect, test } from "bun:test";

import { characterDescription, descriptionLanguage } from "./description";

// Which description a character page shows. Chinese readers get Bangumi's
// summary first and English readers AniList's, each falling back to the
// other; the server has already put an accepted edit in AniList's place and
// taken Bangumi's away (bangumiDescription is null then).

const both = {
  profile: { description: "Stark is a warrior who fights alongside ~!Frieren!~.", gender: null, age: null, birth: null, bloodType: null, siteUrl: null },
  bangumiDescription: "フリーレンとフェルンと共に旅をすることになる戦士で、アイゼンの弟子。",
};

describe("characterDescription", () => {
  test("Chinese pages read Bangumi's first, English pages AniList's", () => {
    expect(characterDescription(both, "zh")).toEqual({ text: both.bangumiDescription, source: "bangumi", lang: "ja" });
    expect(characterDescription(both, "zh-Hant")?.source).toBe("bangumi");
    expect(characterDescription(both, "en")).toEqual({
      text: "Stark is a warrior who fights alongside ~!Frieren!~.",
      source: "anilist",
      lang: "en",
    });
  });

  test("each falls back to the other", () => {
    expect(characterDescription({ ...both, bangumiDescription: null }, "zh")?.source).toBe("anilist");
    expect(characterDescription({ ...both, profile: null }, "en")?.source).toBe("bangumi");
    expect(characterDescription({ profile: null, bangumiDescription: "芙莉莲的弟子。" }, "en")).toEqual({
      text: "芙莉莲的弟子。",
      source: "bangumi",
      lang: "zh",
    });
  });

  test("blank, or markup with no text, is no description", () => {
    expect(characterDescription({ ...both, bangumiDescription: "  \n " }, "zh")?.source).toBe("anilist");
    expect(characterDescription({ profile: { ...both.profile, description: "img220(https://example.org/a.png)" }, bangumiDescription: null }, "en")).toBeNull();
    expect(characterDescription({ profile: null, bangumiDescription: null }, "zh")).toBeNull();
  });
});

describe("descriptionLanguage", () => {
  test("by what the text is mostly written in", () => {
    expect(descriptionLanguage("フリーレンとフェルンと共に旅をする戦士。")).toBe("ja");
    expect(descriptionLanguage("芙莉莲的弟子，后来成为一级魔法使。")).toBe("zh");
    expect(descriptionLanguage("Stark is a warrior who fights alongside Frieren.")).toBe("en");
    // A Japanese name inside English text does not make it Japanese.
    expect(descriptionLanguage("Stark (シュタルク) is a warrior who fights alongside Frieren and Fern.")).toBe("en");
    // Kanji with a little kana is Japanese; kanji alone is Chinese.
    expect(descriptionLanguage("魔法使いの弟子。")).toBe("ja");
  });
});
