import { describe, expect, test } from "bun:test";

import {
  guessLanguage,
  pickDefaultTrack,
  type SelectableTrack,
  type SubtitleLang,
} from "./language";

describe("guessLanguage", () => {
  const cases: [string, Parameters<typeof guessLanguage>[0], SubtitleLang | null, boolean][] = [
    // Track names as fansub groups write them.
    ["简体中文", { name: "简体中文", language: "chi" }, "zh-Hans", false],
    ["簡體中文 is still Simplified", { name: "簡體中文", language: "chi" }, "zh-Hans", false],
    ["繁體中文", { name: "繁體中文", language: "chi" }, "zh-Hant", false],
    ["CHS", { name: "CHS" }, "zh-Hans", false],
    ["CHT", { name: "CHT" }, "zh-Hant", false],
    ["简日双语", { name: "简日双语" }, "zh-Hans", true],
    ["繁日雙語", { name: "繁日雙語" }, "zh-Hant", true],
    ["CHS&JPN", { name: "CHS&JPN" }, "zh-Hans", true],
    ["English name", { name: "English", language: "eng" }, "en", false],
    ["日本語", { name: "日本語" }, "ja", false],
    // Sidecar suffixes.
    [".sc", { name: "sc" }, "zh-Hans", false],
    [".tc", { name: "tc" }, "zh-Hant", false],
    [".zh-Hant", { name: "zh-Hant" }, "zh-Hant", false],
    [".zh_CN", { name: "zh_CN" }, "zh-Hans", false],
    ["[简体]", { name: "[简体]" }, "zh-Hans", false],
    // Short codes only as whole tokens.
    ["'sc' inside a word is not Chinese", { name: "description" }, null, false],
    ["'tc' inside a word is not Chinese", { name: "batch" }, null, false],
    // Tags when the name says nothing about script.
    ["BCP 47 zh-Hant", { name: "", languageBcp47: "zh-Hant", language: "chi" }, "zh-Hant", false],
    ["BCP 47 zh-CN", { languageBcp47: "zh-CN" }, "zh-Hans", false],
    ["name 'Chinese' defers to the tag", { name: "Chinese", languageBcp47: "zh-TW" }, "zh-Hant", false],
    ["ISO chi alone cannot tell the script", { language: "chi" }, "zh", false],
    ["ISO jpn", { language: "jpn" }, "ja", false],
    ["und is unknown", { language: "und" }, null, false],
    ["nothing", {}, null, false],
    // A name that names both scripts gives no single answer.
    ["简繁 falls through to the tag", { name: "简繁", language: "chi" }, "zh", false],
  ];
  for (const [label, hints, lang, bilingual] of cases) {
    test(label, () => {
      expect(guessLanguage(hints)).toEqual({ lang, bilingual });
    });
  }
});

function t(id: string, over: Partial<SelectableTrack> = {}): SelectableTrack {
  return {
    id,
    lang: null,
    supported: true,
    isDefault: false,
    isForced: false,
    styled: true,
    source: "embedded",
    ...over,
  };
}

describe("pickDefaultTrack", () => {
  const chs = t("chs", { lang: "zh-Hans" });
  const cht = t("cht", { lang: "zh-Hant", isDefault: true });
  const eng = t("eng", { lang: "en", styled: false });

  test("the site language wins over the file's default flag", () => {
    expect(pickDefaultTrack([cht, chs, eng], null, "zh")).toBe("chs");
    expect(pickDefaultTrack([chs, cht, eng], null, "zh-Hant")).toBe("cht");
    expect(pickDefaultTrack([chs, cht, eng], null, "en")).toBe("eng");
  });

  test("the reader's last choice wins over the site language", () => {
    expect(pickDefaultTrack([chs, cht, eng], "zh-Hant", "zh")).toBe("cht");
    expect(pickDefaultTrack([chs, cht, eng], "en", "zh")).toBe("eng");
  });

  test("'off' means no track, whatever the file has", () => {
    expect(pickDefaultTrack([chs, cht], "off", "zh")).toBeNull();
  });

  test("a Chinese reader gets the other script before English", () => {
    expect(pickDefaultTrack([eng, cht], null, "zh")).toBe("cht");
    expect(pickDefaultTrack([eng, t("zh", { lang: "zh" }), cht], null, "zh")).toBe("zh");
  });

  test("forced tracks are skipped while a full track exists", () => {
    const signs = t("signs", { lang: "zh-Hans", isForced: true, isDefault: true });
    expect(pickDefaultTrack([signs, chs], null, "zh")).toBe("chs");
    expect(pickDefaultTrack([signs], null, "zh")).toBe("signs");
  });

  test("unsupported tracks are never picked", () => {
    const pgs = t("pgs", { lang: "zh-Hans", supported: false, isDefault: true });
    expect(pickDefaultTrack([pgs, eng], null, "zh")).toBe("eng");
    expect(pickDefaultTrack([pgs], null, "zh")).toBeNull();
  });

  test("at equal rank: default flag, then styled, then sidecar, then order", () => {
    const a = t("a", { lang: "zh-Hans", styled: false });
    const b = t("b", { lang: "zh-Hans", isDefault: true, styled: false });
    expect(pickDefaultTrack([a, b], null, "zh")).toBe("b");
    const c = t("c", { lang: "zh-Hans", styled: true });
    expect(pickDefaultTrack([a, c], null, "zh")).toBe("c");
    const side = t("side", { lang: "zh-Hans", source: "sidecar" });
    expect(pickDefaultTrack([c, side], null, "zh")).toBe("side");
    const d = t("d", { lang: "zh-Hans" });
    expect(pickDefaultTrack([c, d], null, "zh")).toBe("c");
  });

  test("no language match: the file's default, else the first", () => {
    const x = t("x", { lang: "ko" });
    const y = t("y", { lang: null, isDefault: true });
    expect(pickDefaultTrack([x, y], null, "zh")).toBe("y");
    expect(pickDefaultTrack([x], null, "zh")).toBe("x");
  });
});
