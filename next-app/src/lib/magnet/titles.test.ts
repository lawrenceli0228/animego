import { describe, expect, test } from "bun:test";
import { magnetToneVars, parseHue, titleVariants } from "./titles";

describe("titleVariants", () => {
  test("Frieren season 2: four titles, four buttons, in order", () => {
    expect(
      titleVariants({
        titleChinese: "葬送的芙莉莲 第二季",
        titleRomaji: "Sousou no Frieren 2nd Season",
        titleEnglish: "Frieren: Beyond Journey's End Season 2",
        titleNative: "葬送のフリーレン 第2期",
      }).map((v) => v.kind),
    ).toEqual(["chinese", "romaji", "english", "native"]);
  });

  test("a repeated title (any case) and missing titles get no button", () => {
    expect(
      titleVariants({
        titleChinese: null,
        titleRomaji: "Bocchi the Rock!",
        titleEnglish: "BOCCHI THE ROCK!",
        titleNative: "  ",
      }),
    ).toEqual([{ kind: "romaji", value: "Bocchi the Rock!" }]);
  });
});

describe("parseHue", () => {
  test("reads the computed custom property", () => {
    expect(parseHue(" 225.4")).toBe(225.4);
    expect(parseHue("0")).toBe(0);
  });
  test("nothing to read → null", () => {
    expect(parseHue("")).toBeNull();
    expect(parseHue(undefined)).toBeNull();
    expect(parseHue("violet")).toBeNull();
  });
});

describe("magnetToneVars", () => {
  test("the canvas's tokens for hue 225.4", () => {
    expect(magnetToneVars(225.4)).toEqual({
      "--tone": "oklch(76% 0.085 225.4)",
      "--tone-dim": "oklch(76% 0.085 225.4 / 0.15)",
      "--tone-line": "oklch(76% 0.085 225.4 / 0.35)",
      "--tone-hover": "oklch(82% 0.085 225.4)",
      "--on": "oklch(18% 0.04 225.4)",
    });
  });
  test("no hue is grey, not red", () => {
    expect(magnetToneVars(null)["--tone"]).toBe("oklch(76% 0 0)");
  });
});
