import { describe, expect, test } from "bun:test";

import { LANGS } from "@/lib/i18n/lang";
import { pickCharacterName, pickVoiceActorName } from "@/lib/formatters";
import {
  characterDisplayName,
  personDisplayName,
  secondaryNames,
} from "./names";
import type { EntityName } from "./types";

const STARK: EntityName = { full: "Stark", native: "シュタルク", cn: "修塔尔克" };
const KOBAYASHI: EntityName = { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" };

describe("the name ladders", () => {
  test("zh prefers Bangumi's Chinese name, then the native one, then the romanised one", () => {
    expect(characterDisplayName(STARK, "zh")).toBe("修塔尔克");
    expect(characterDisplayName({ ...STARK, cn: null }, "zh")).toBe("シュタルク");
    expect(characterDisplayName({ full: "Stark", native: null, cn: null }, "zh")).toBe("Stark");
    expect(personDisplayName({ ...KOBAYASHI, cn: null }, "zh")).toBe("小林千晃");
  });

  test("en prefers the romanised name", () => {
    expect(characterDisplayName(STARK, "en")).toBe("Stark");
    expect(personDisplayName(KOBAYASHI, "en")).toBe("Chiaki Kobayashi");
    expect(personDisplayName({ full: null, native: "小林千晃", cn: "小林千晃" }, "en")).toBe("小林千晃");
  });

  test("zh-Hant reads the Chinese name like zh", () => {
    expect(characterDisplayName(STARK, "zh-Hant")).toBe("修塔尔克");
  });

  test("an empty name is an empty string, never 'null'", () => {
    expect(personDisplayName({ full: null, native: null, cn: null }, "zh")).toBe("");
    expect(personDisplayName({ full: "", native: "  ", cn: null }, "zh")).toBe("");
  });

  // The person and character pages must name people exactly as the detail
  // page's cast list does, or a reader clicking a voice actor lands on a page
  // titled differently from the link they clicked. The detail page reads the
  // same three names under its own field names; the ladders are pinned
  // against the site's pickers rather than restated.
  test("agree with the detail page's pickers in every language", () => {
    const samples: EntityName[] = [
      STARK,
      { full: "Stark", native: "シュタルク", cn: null },
      { full: "Stark", native: null, cn: null },
      { full: null, native: "シュタルク", cn: "修塔尔克" },
      { full: null, native: null, cn: "修塔尔克" },
    ];
    for (const lang of LANGS) {
      for (const n of samples) {
        expect(characterDisplayName(n, lang)).toBe(
          pickCharacterName({ nameEn: n.full, nameJa: n.native, nameCn: n.cn }, lang),
        );
        expect(personDisplayName(n, lang)).toBe(
          pickVoiceActorName({ voiceActorEn: n.full, voiceActorJa: n.native, voiceActorCn: n.cn }, lang),
        );
      }
    }
  });
});

describe("secondaryNames", () => {
  test("the names under the heading, without the one in it and without repeats", () => {
    expect(secondaryNames(STARK, "修塔尔克")).toEqual({ native: "シュタルク", full: "Stark" });
    // 小林千晃 is the same in Chinese and Japanese: the native line would
    // repeat the heading, so it is dropped.
    expect(secondaryNames(KOBAYASHI, "小林千晃")).toEqual({ native: null, full: "Chiaki Kobayashi" });
    // An English heading still shows the native name, and not itself again.
    expect(secondaryNames(KOBAYASHI, "Chiaki Kobayashi")).toEqual({ native: "小林千晃", full: null });
  });
});
