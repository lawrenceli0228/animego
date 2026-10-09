import { describe, expect, test } from "bun:test";

import type { CastCharacter, CastVoice } from "@/lib/types";
import {
  CHARACTER_ROLE_LABEL,
  DUB_LABEL,
  appendCastPage,
  castCardView,
  charactersQuery,
  characterRoleLabel,
  roleCount,
  voiceNoteLabel,
} from "./cast";

// What one card on the 角色 tab says: the character on the left, the voice on
// the right, and the line under the voice — the dub, or the second voice
// when there is one (童年 · 某某). Names go through the site's existing
// ladders, so a card and the overview's row name the same person the same way.

const voice = (over: Partial<CastVoice> = {}): CastVoice => ({
  staffId: 112215,
  nameFull: "Atsumi Tanezaki",
  nameNative: "種﨑敦美",
  nameCn: "种崎敦美",
  imageUrl: "https://s4.anilist.co/file/anilistcdn/staff/medium/a.jpg",
  roleNotes: null,
  dubGroup: null,
  ...over,
});

const frieren = (over: Partial<CastCharacter> = {}): CastCharacter => ({
  characterId: 176754,
  role: "MAIN",
  nameEn: "Frieren",
  nameJa: "フリーレン",
  nameCn: "芙莉莲",
  imageUrl: "https://s4.anilist.co/file/anilistcdn/character/medium/f.png",
  voices: [voice()],
  ...over,
});

describe("castCardView", () => {
  test("zh: the Chinese name first, the Japanese one under it, 日配 under the voice", () => {
    const card = castCardView(frieren(), "ja", "zh", 0);
    expect(card.name).toBe("芙莉莲");
    expect(card.altName).toBe("フリーレン");
    expect(card.roleLabel).toBe("主角");
    expect(card.isMain).toBe(true);
    expect(card.voice).toEqual({
      name: "种崎敦美",
      altName: "種﨑敦美",
      imageUrl: "https://s4.anilist.co/file/anilistcdn/staff/medium/a.jpg",
    });
    expect(card.note).toBe("日配");
    expect(card.key).toBe("c176754");
  });

  test("zh without a Chinese name: Japanese first, romaji under it", () => {
    const card = castCardView(frieren({ nameCn: null, voices: [voice({ nameCn: null })] }), "ja", "zh", 0);
    expect(card.name).toBe("フリーレン");
    expect(card.altName).toBe("Frieren");
    expect(card.voice?.name).toBe("種﨑敦美");
    expect(card.voice?.altName).toBe("Atsumi Tanezaki");
  });

  test("en: romaji first, the Japanese under it", () => {
    const card = castCardView(frieren(), "ja", "en", 0);
    expect(card.name).toBe("Frieren");
    expect(card.altName).toBe("フリーレン");
    expect(card.roleLabel).toBe("Main");
    expect(card.voice?.name).toBe("Atsumi Tanezaki");
    expect(card.note).toBe("Japanese");
  });

  test("a childhood voice is named under the main one", () => {
    const card = castCardView(
      frieren({ voices: [voice(), voice({ staffId: 2, nameCn: "童星", nameNative: "子役", roleNotes: "Childhood" })] }),
      "ja",
      "zh",
      0,
    );
    expect(card.voice?.name).toBe("种崎敦美");
    expect(card.note).toBe("童年 · 童星");
    expect(castCardView(frieren({ voices: [voice(), voice({ staffId: 2, nameCn: null, nameNative: "子役", roleNotes: "Childhood" })] }), "ja", "en", 0).note)
      .toBe("Childhood · Atsumi Tanezaki");
  });

  test("a second voice with no notes is named under the dub", () => {
    const card = castCardView(frieren({ voices: [voice(), voice({ staffId: 3, nameCn: "接替者", roleNotes: null })] }), "ja", "zh", 0);
    expect(card.note).toBe("日配 · 接替者");
  });

  test("a single voice with notes says so", () => {
    expect(castCardView(frieren({ voices: [voice({ roleNotes: "Young" })] }), "zh", "zh", 0).note).toBe("中配 · 少年");
    expect(castCardView(frieren({ voices: [voice({ roleNotes: "eps 511" })] }), "ja", "zh", 0).note).toBe("日配 · eps 511");
  });

  test("no voice in this dub: no voice and no note", () => {
    const card = castCardView(frieren({ voices: [] }), "ko", "zh", 3);
    expect(card.voice).toBeNull();
    expect(card.note).toBe("");
  });

  test("a row without an id still gets a stable key and the 客串 label", () => {
    const card = castCardView(frieren({ characterId: null, role: "BACKGROUND" }), "ja", "zh", 7);
    expect(card.key).toBe("i7");
    expect(card.roleLabel).toBe("客串");
    expect(card.isMain).toBe(false);
  });

  test("the alternate name is never the same string as the name", () => {
    const card = castCardView(frieren({ nameCn: null, nameJa: "Frieren", nameEn: "Frieren" }), "ja", "zh", 0);
    expect(card.name).toBe("Frieren");
    expect(card.altName).toBeNull();
  });
});

describe("labels", () => {
  test("roles, in every language, with a fallback for what AniList adds", () => {
    expect(characterRoleLabel("SUPPORTING", "zh")).toBe("配角");
    expect(characterRoleLabel("background", "zh-Hant")).toBe("客串");
    expect(characterRoleLabel(null, "en")).toBe("Supporting");
    expect(characterRoleLabel("CAMEO", "zh")).toBe("CAMEO");
    for (const lang of ["zh", "en", "zh-Hant"] as const) {
      expect(Object.keys(CHARACTER_ROLE_LABEL[lang]).sort()).toEqual(["BACKGROUND", "MAIN", "SUPPORTING"]);
      expect(Object.keys(DUB_LABEL[lang]).sort()).toEqual(["ja", "ko", "zh"]);
    }
    expect(DUB_LABEL["zh-Hant"].ko).toBe("韓配");
  });

  test("voice notes: the common ones translated, the rest as AniList wrote them", () => {
    expect(voiceNoteLabel("Childhood", "zh")).toBe("童年");
    expect(voiceNoteLabel("child", "zh-Hant")).toBe("童年");
    expect(voiceNoteLabel("Young", "zh")).toBe("少年");
    expect(voiceNoteLabel("Childhood", "en")).toBe("Childhood");
    expect(voiceNoteLabel("Female", "zh")).toBe("Female");
  });
});

describe("charactersQuery", () => {
  test("only what differs from the endpoint's defaults", () => {
    expect(charactersQuery({ role: "all", dub: null, q: "", offset: 0, limit: 24 })).toBe("limit=24");
    expect(charactersQuery({ role: "main", dub: "zh", q: "  芙莉 ", offset: 24, limit: 48 })).toBe(
      "role=main&lang=zh&q=%E8%8A%99%E8%8E%89&offset=24&limit=48",
    );
  });
});

describe("roleCount", () => {
  test("reads the count for a filter", () => {
    const counts = { all: 100, main: 3, supporting: 40, background: 57 };
    expect(roleCount(counts, "all")).toBe(100);
    expect(roleCount(counts, "background")).toBe(57);
  });
});

describe("appendCastPage", () => {
  test("adds the next page after what is shown", () => {
    const a = frieren({ characterId: 1 });
    const b = frieren({ characterId: 2 });
    expect(appendCastPage([a], [b]).map((c) => c.characterId)).toEqual([1, 2]);
  });

  test("drops a character already shown", () => {
    // The first page came from the cached HTML, the next from a list the
    // server has since re-read: a character added in between shifts every
    // offset by one, and the last card of page one comes round again.
    const shown = [frieren({ characterId: 1 }), frieren({ characterId: 2 })];
    const next = [frieren({ characterId: 2 }), frieren({ characterId: 3 })];
    expect(appendCastPage(shown, next).map((c) => c.characterId)).toEqual([1, 2, 3]);
  });

  test("keeps rows without an AniList id, which cannot be told apart", () => {
    const shown = [frieren({ characterId: null })];
    expect(appendCastPage(shown, [frieren({ characterId: null })])).toHaveLength(2);
  });

  test("leaves its inputs alone", () => {
    const shown = [frieren({ characterId: 1 })];
    const next = [frieren({ characterId: 2 })];
    appendCastPage(shown, next);
    expect(shown).toHaveLength(1);
    expect(next).toHaveLength(1);
  });
});
