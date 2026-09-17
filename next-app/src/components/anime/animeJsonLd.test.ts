// The people and the breadcrumb on the TVSeries document. The episode-count
// rule and sameAs are pinned in lib/formatters.test.ts, which predates this
// file; these cover what phase 3.2 added.

import { describe, expect, test } from "bun:test";
import {
  breadcrumbParent,
  buildBreadcrumbJsonLd,
  buildJsonLd,
  castJsonLd,
} from "@/components/anime/animeJsonLd";
import { DETAIL_CHARACTERS_SHOWN, DETAIL_STAFF_SHOWN } from "@/components/anime/detailPeople";
import type { AnimeDetail, DetailCharacter, DetailStaff } from "@/lib/types";

function detailRow(over: Partial<AnimeDetail>): AnimeDetail {
  return {
    anilistId: 154587,
    titleRomaji: "Sousou no Frieren",
    titleEnglish: "Frieren: Beyond Journey's End",
    titleNative: "葬送のフリーレン",
    titleChinese: "葬送的芙莉莲",
    coverImageUrl: null,
    description: null,
    episodes: 28,
    startDate: { year: 2023, month: 9, day: 29 },
    season: "FALL",
    seasonYear: 2023,
    genres: ["Adventure", "Drama", "Fantasy"],
    studios: ["MADHOUSE"],
    characters: [],
    staff: [],
    bangumiScore: null,
    bangumiVotes: null,
    ...over,
  } as AnimeDetail;
}

function character(over: Partial<DetailCharacter>): DetailCharacter {
  return {
    nameEn: null,
    nameJa: null,
    nameCn: null,
    role: "MAIN",
    imageUrl: null,
    voiceActorEn: null,
    voiceActorJa: null,
    voiceActorCn: null,
    voiceActorImageUrl: null,
    ...over,
  };
}

function staff(over: Partial<DetailStaff>): DetailStaff {
  return { nameEn: null, nameJa: null, role: "", imageUrl: null, ...over };
}

describe("cast", () => {
  test("actor is the voice actor, character is who they play, each with its AniList page", () => {
    const { actor, character: chars } = castJsonLd(
      [
        character({
          nameEn: "Frieren",
          nameJa: "フリーレン",
          characterId: 190364,
          voiceActorEn: "Atsumi Tanezaki",
          voiceActorJa: "種﨑敦美",
          voiceActorId: 119331,
        }),
      ],
      "en",
    );
    expect(actor).toEqual([
      { "@type": "Person", name: "Atsumi Tanezaki", sameAs: "https://anilist.co/staff/119331" },
    ]);
    expect(chars).toEqual([
      { "@type": "Person", name: "Frieren", sameAs: "https://anilist.co/character/190364" },
    ]);
  });

  test("names follow the page's language ladder", () => {
    const rows = [character({ nameEn: "Frieren", nameJa: "フリーレン", voiceActorEn: "Atsumi Tanezaki", voiceActorJa: "種﨑敦美" })];
    expect(castJsonLd(rows, "zh").character[0].name).toBe("フリーレン");
    expect(castJsonLd(rows, "zh").actor[0].name).toBe("種﨑敦美");
    expect(castJsonLd(rows, "en").character[0].name).toBe("Frieren");
  });

  test("a row written before migration 0037 has no id and so no sameAs", () => {
    const { actor } = castJsonLd([character({ voiceActorEn: "Atsumi Tanezaki" })], "en");
    expect(actor).toEqual([{ "@type": "Person", name: "Atsumi Tanezaki" }]);
    expect(actor[0]).not.toHaveProperty("sameAs");
  });

  test("a character with no voice actor contributes no actor, and vice versa", () => {
    const { actor, character: chars } = castJsonLd(
      [character({ nameEn: "Narrator" }), character({ voiceActorEn: "Somebody" })],
      "en",
    );
    expect(chars.map((c) => c.name)).toEqual(["Narrator"]);
    expect(actor.map((a) => a.name)).toEqual(["Somebody"]);
  });

  test("one actor voicing two characters is one Person", () => {
    const { actor } = castJsonLd(
      [
        character({ nameEn: "A", voiceActorEn: "Same Person", voiceActorId: 1 }),
        character({ nameEn: "B", voiceActorEn: "Same Person", voiceActorId: 1 }),
      ],
      "en",
    );
    expect(actor).toHaveLength(1);
  });

  test("only the characters the page draws are named", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      character({ nameEn: `C${i}`, voiceActorEn: `V${i}` }),
    );
    const { actor, character: chars } = castJsonLd(rows, "en");
    expect(chars).toHaveLength(DETAIL_CHARACTERS_SHOWN);
    expect(actor).toHaveLength(DETAIL_CHARACTERS_SHOWN);
    expect(chars[chars.length - 1].name).toBe(`C${DETAIL_CHARACTERS_SHOWN - 1}`);
  });
});

describe("director and musicBy", () => {
  test("Director and Chief Director are directors; other *Director roles are not", () => {
    const ld = buildJsonLd(
      detailRow({
        staff: [
          staff({ nameEn: "Keiichirou Saitou", role: "Director", staffId: 133393 }),
          staff({ nameEn: "Chief", role: "Chief Director" }),
          staff({ nameEn: "Art", role: "Art Director" }),
          staff({ nameEn: "Sound", role: "Sound Director" }),
          staff({ nameEn: "Episode", role: "Episode Director (eps 3, 7)" }),
          staff({ nameEn: "Assistant", role: "Assistant Director" }),
        ],
      }),
      "en",
    );
    expect(ld.director).toEqual([
      { "@type": "Person", name: "Keiichirou Saitou", sameAs: "https://anilist.co/staff/133393" },
      { "@type": "Person", name: "Chief" },
    ]);
  });

  test("a role with a trailing space (423 prod rows) still matches", () => {
    const ld = buildJsonLd(detailRow({ staff: [staff({ nameEn: "D", role: "Director " })] }), "en");
    expect(ld.director?.map((d) => d.name)).toEqual(["D"]);
  });

  test("Music is musicBy", () => {
    const ld = buildJsonLd(
      detailRow({ staff: [staff({ nameEn: "Evan Call", role: "Music", staffId: 152203 })] }),
      "en",
    );
    expect(ld.musicBy).toEqual([
      { "@type": "Person", name: "Evan Call", sameAs: "https://anilist.co/staff/152203" },
    ]);
  });

  test("zh names the director in Japanese, as the staff grid does", () => {
    const ld = buildJsonLd(
      detailRow({ staff: [staff({ nameEn: "Keiichirou Saitou", nameJa: "斎藤圭一郎", role: "Director" })] }),
      "zh",
    );
    expect(ld.director?.[0].name).toBe("斎藤圭一郎");
  });

  test("a director past the rows the page draws is not named", () => {
    const filler = Array.from({ length: DETAIL_STAFF_SHOWN }, (_, i) =>
      staff({ nameEn: `S${i}`, role: "Key Animation" }),
    );
    const ld = buildJsonLd(
      detailRow({ staff: [...filler, staff({ nameEn: "Late", role: "Director" })] }),
      "en",
    );
    expect(ld).not.toHaveProperty("director");
  });

  test("no people at all emits none of the four properties", () => {
    const ld = buildJsonLd(detailRow({ characters: [], staff: [] }), "en");
    expect(ld).not.toHaveProperty("actor");
    expect(ld).not.toHaveProperty("character");
    expect(ld).not.toHaveProperty("director");
    expect(ld).not.toHaveProperty("musicBy");
  });

  test("an older API build that sends no characters/staff arrays does not throw", () => {
    const row = detailRow({});
    delete (row as Partial<AnimeDetail>).characters;
    delete (row as Partial<AnimeDetail>).staff;
    expect(() => buildJsonLd(row, "en")).not.toThrow();
  });
});

describe("alternateName", () => {
  test("is the other three titles only; synonyms stay out while the page shows none", () => {
    const ld = buildJsonLd(
      detailRow({ synonyms: ["Frieren at the Funeral", "Sousou no Frieren", "葬送的芙莉莲"] }),
      "zh",
    );
    expect(ld.alternateName).toEqual([
      "Sousou no Frieren",
      "Frieren: Beyond Journey's End",
      "葬送のフリーレン",
    ]);
  });
});

describe("productionCompany", () => {
  test("carries the studio's AniList page once studioDetails has its id", () => {
    const ld = buildJsonLd(
      detailRow({
        studios: ["MADHOUSE"],
        studioDetails: [
          { name: "MADHOUSE", studioId: 11, isMain: true },
          { name: "Toho", studioId: 1, isMain: false },
        ],
      }),
      "en",
    );
    expect(ld.productionCompany).toEqual([
      { "@type": "Organization", name: "MADHOUSE", sameAs: "https://anilist.co/studio/11" },
    ]);
  });

  test("stays a bare name on a row not yet re-read", () => {
    const ld = buildJsonLd(detailRow({ studios: ["MADHOUSE"] }), "en");
    expect(ld.productionCompany).toEqual([{ "@type": "Organization", name: "MADHOUSE" }]);
  });
});

describe("breadcrumb parent", () => {
  test("a title with a season hangs under /seasonal", () => {
    expect(breadcrumbParent(detailRow({ season: "FALL", seasonYear: 2023 }), "zh")).toEqual({
      name: "2023 秋季",
      path: "/seasonal/fall/2023",
    });
    expect(breadcrumbParent(detailRow({ season: "FALL", seasonYear: 2023 }), "en")?.name).toBe(
      "Fall 2023",
    );
  });

  test("a title with a year but no season hangs under /year", () => {
    expect(
      breadcrumbParent(detailRow({ season: null, seasonYear: null, startDate: "2019-07-19" }), "en"),
    ).toEqual({ name: "Anime of 2019", path: "/year/2019" });
    expect(
      breadcrumbParent(
        detailRow({ season: null, seasonYear: null, startDate: { year: 2019, month: null, day: null } }),
        "zh",
      ),
    ).toEqual({ name: "2019年番剧", path: "/year/2019" });
  });

  test("a title with neither hangs under its first genre that has a page", () => {
    const row = detailRow({ season: null, seasonYear: null, startDate: null, genres: ["Hentai", "Drama"] });
    expect(breadcrumbParent(row, "en")).toEqual({ name: "Drama Anime", path: "/genre/drama" });
  });

  test("a title with nothing to hang under has no parent", () => {
    const row = detailRow({ season: null, seasonYear: null, startDate: null, genres: [] });
    expect(breadcrumbParent(row, "en")).toBeNull();
  });
});

describe("BreadcrumbList", () => {
  test("home › season › title, with absolute locale-prefixed URLs and no item on the last crumb", () => {
    const ld = buildBreadcrumbJsonLd(detailRow({}), "en", "Home");
    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://animegoclub.com/en" },
        {
          "@type": "ListItem",
          position: 2,
          name: "Fall 2023",
          item: "https://animegoclub.com/en/seasonal/fall/2023",
        },
        { "@type": "ListItem", position: 3, name: "Frieren: Beyond Journey's End" },
      ],
    });
  });

  test("the default locale keeps bare URLs", () => {
    const ld = buildBreadcrumbJsonLd(detailRow({}), "zh", "首页");
    expect(ld.itemListElement[0].item).toBe("https://animegoclub.com/");
    expect(ld.itemListElement[1].item).toBe("https://animegoclub.com/seasonal/fall/2023");
    expect(ld.itemListElement[2].name).toBe("葬送的芙莉莲");
  });

  test("positions stay contiguous when there is no middle crumb", () => {
    const row = detailRow({ season: null, seasonYear: null, startDate: null, genres: [] });
    const ld = buildBreadcrumbJsonLd(row, "en", "Home");
    expect(ld.itemListElement.map((c) => c.position)).toEqual([1, 2]);
    expect(ld.itemListElement[1]).not.toHaveProperty("item");
  });
});
