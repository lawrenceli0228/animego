import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickTitle } from "@/lib/formatters";
import { LANGS, type Lang } from "@/lib/i18n/lang";

// A card must be able to carry every title its reader's ladder asks for.
//
// /zh-Hant/search rendered Simplified titles — 12 of 18 cards, measured on
// production — while the home page, the seasonal page, the calendar and the
// detail page were all correct. The difference was not the ladder, which has
// had `titleHant` on its first zh-Hant rung since migration 0022, and not the
// API, which has returned the field just as long. It was that those other
// surfaces pass a row straight through to <AnimeCard>, so the field arrives
// whether or not a TypeScript type mentions it, and /search hand-builds the
// card object field by field. `titleHant` was not among the fields.
//
// That is the shape of the defect: TypeScript cannot see it (a missing
// optional property is not an error, and the ladder reads by string key at
// runtime), a reviewer cannot see it (each file is individually reasonable),
// and a reader cannot see it either (a Simplified title is legible to a
// Traditional reader — it just is not what they asked for). Only a whole-repo
// rule catches it, which is why this is a test and not a code review note.

/** Every field name any ladder could name. Kept explicit so a new one fails. */
const TITLE_FIELDS = [
  "titleChinese",
  "titleHant",
  "titleRomaji",
  "titleEnglish",
  "titleNative",
] as const;

/**
 * The fields `lang`'s ladder actually reads, derived by ASKING pickTitle
 * rather than by parsing TITLE_LADDER.
 *
 * Probing beats parsing here: the ladder is a private const, and a test that
 * scraped it would agree with a broken implementation as readily as with a
 * working one. Handing pickTitle an object with exactly one field set and
 * seeing whether it comes back out is the same question the product asks.
 */
function ladderFieldsFor(lang: Lang): string[] {
  return TITLE_FIELDS.filter((f) => pickTitle({ [f]: "PROBE" }, lang) === "PROBE");
}

const LADDER_FIELDS = [...new Set(LANGS.flatMap((l) => ladderFieldsFor(l)))].sort();

const SRC = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the probe finds a ladder at all", () => {
  // Anti-vacuity. Every assertion below is "these fields are present"; if the
  // probe returned nothing, all of them would pass while checking nothing.
  test("each language reads at least two fields", () => {
    for (const lang of LANGS) {
      expect(ladderFieldsFor(lang).length, `${lang} ladder`).toBeGreaterThan(1);
    }
  });

  test("zh-Hant reads titleHant — the rung this file exists for", () => {
    expect(ladderFieldsFor("zh-Hant")).toContain("titleHant");
  });

  test("zh-Hant prefers Traditional over Simplified when it has both", () => {
    // The ordering, not just the membership. A ladder that listed titleHant
    // last would pass the test above and still render Simplified.
    expect(
      pickTitle({ titleHant: "進擊的巨人", titleChinese: "进击的巨人" }, "zh-Hant"),
    ).toBe("進擊的巨人");
  });
});

describe("AnimeCardData can express every rung", () => {
  test("the interface declares every field some ladder reads", () => {
    const src = read("components/anime/AnimeCard.tsx");
    const body = /export interface AnimeCardData \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(body, "AnimeCardData interface not found — did it move or get renamed?").toBeTruthy();

    for (const field of LADDER_FIELDS) {
      expect(
        new RegExp(`^\\s*${field}\\??:`, "m").test(body!),
        `AnimeCardData is missing \`${field}\`, which a ladder reads. A card ` +
          `built to this type cannot carry it, so that reader silently gets ` +
          `a lower rung.`,
      ).toBe(true);
    }
  });
});

describe("every hand-built card object sets every rung", () => {
  // Sites that construct the object literally rather than passing a row
  // through. Listed rather than globbed: the list IS the finding — three of
  // the four <AnimeCard> call sites forward a row and are fine by
  // construction, and only a hand-built one can drop a field.
  const HAND_BUILT: readonly (readonly [string, string])[] = [
    ["app/[lang]/search/page.tsx", "cardData"],
  ];

  test("the construction sites are still where this test thinks they are", () => {
    // If /search stops hand-building, delete its entry — do not let this file
    // keep passing by checking a literal that no longer exists.
    for (const [file, name] of HAND_BUILT) {
      expect(
        read(file).includes(`const ${name}: AnimeCardData = {`),
        `${file} no longer builds \`${name}\` as an AnimeCardData literal. ` +
          `Update HAND_BUILT — either it moved, or the site now forwards a ` +
          `row and the entry should go.`,
      ).toBe(true);
    }
  });

  test("no site is missing a title field", () => {
    for (const [file, name] of HAND_BUILT) {
      const src = read(file);
      const start = src.indexOf(`const ${name}: AnimeCardData = {`);
      const literal = src.slice(start, src.indexOf("};", start));

      for (const field of LADDER_FIELDS) {
        expect(
          new RegExp(`^\\s*${field}:`, "m").test(literal),
          `${file} builds \`${name}\` without \`${field}\`. The API returns ` +
            `it and AnimeCardData accepts it, so the card will render a ` +
            `lower rung of the ladder for no reason — which is exactly how ` +
            `/zh-Hant/search shipped Simplified titles.`,
        ).toBe(true);
      }
    }
  });
});
