import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildJsonLd } from "@/components/anime/animeJsonLd";
import { resolveEpisodeSkeleton } from "@/components/anime/episodeGridSkeleton";
import {
  formatFuzzyDate,
  formatScore,
  pickCharacterName,
  pickDescription,
  pickSeoTitle,
  pickStaffName,
  pickTitle,
  pickVoiceActorName,
  stripHtml,
  truncate,
  truncateVisual,
  visualWidth,
} from "./formatters";
import type { AnimeDetail } from "./types";

describe("formatFuzzyDate", () => {
  test("returns YYYY-MM-DD when all three fields present", () => {
    expect(formatFuzzyDate({ year: 2021, month: 12, day: 5 })).toBe("2021-12-05");
  });

  test("pads single-digit month and day with leading zero", () => {
    expect(formatFuzzyDate({ year: 2023, month: 3, day: 9 })).toBe("2023-03-09");
  });

  test("returns YYYY-MM when day is missing", () => {
    expect(formatFuzzyDate({ year: 2024, month: 7, day: null })).toBe("2024-07");
  });

  test("returns YYYY when only year is present", () => {
    expect(formatFuzzyDate({ year: 2020, month: null, day: null })).toBe("2020");
  });

  test("returns null when input is null", () => {
    expect(formatFuzzyDate(null)).toBeNull();
  });

  test("returns null when year is missing (cannot format a partial-without-year date)", () => {
    expect(formatFuzzyDate({ year: null, month: 5, day: 12 })).toBeNull();
  });

  test("passes through legacy string shape unchanged", () => {
    // Defensive: if upstream ever normalises to ISO string, do not double-format.
    expect(formatFuzzyDate("2021-12-05")).toBe("2021-12-05");
  });
});

describe("pickTitle", () => {
  test("prefers Chinese for zh", () => {
    expect(
      pickTitle({ titleChinese: "鬼灭之刃", titleEnglish: "Demon Slayer" }, "zh"),
    ).toBe("鬼灭之刃");
  });

  test("falls back to English when Chinese missing for zh", () => {
    expect(pickTitle({ titleChinese: null, titleRomaji: "Kimetsu" }, "zh")).toBe("Kimetsu");
  });

  test("prefers English for en", () => {
    expect(
      pickTitle({ titleChinese: "鬼灭之刃", titleEnglish: "Demon Slayer" }, "en"),
    ).toBe("Demon Slayer");
  });

  test("returns empty string when all titles missing", () => {
    expect(pickTitle({}, "zh")).toBe("");
  });
});

// The SERP boundary, at its last mile.
//
// The database half is enforced by a generated column and covered by
// test/integration/hant_seo_boundary_test.go. This half is the rule that the
// code reading it must ask for the right field, and the failure it guards
// against is a one-word edit: someone "tidying" generateMetadata back to
// pickTitle. That edit compiles, renders, and passes every other test, and its
// only symptom is Google learning a machine-invented name for the page.
describe("pickSeoTitle", () => {
  // A row the backfill filled by conversion: the display field carries the
  // converted text, the SEO field is NULL because Postgres made it NULL.
  const converted = {
    titleChinese: "葬送的芙莉莲",
    titleHant: "葬送的芙莉蓮",
    titleHantSeo: null,
    titleNative: "葬送のフリーレン",
  };

  // A row a human or dataset supplied: both fields carry it.
  const human = {
    titleChinese: "鬼灭之刃",
    titleHant: "鬼滅之刃",
    titleHantSeo: "鬼滅之刃",
    titleNative: "鬼滅の刃",
  };

  test("publishes a human-sourced Traditional title", () => {
    expect(pickSeoTitle(human, "zh-Hant")).toBe("鬼滅之刃");
  });

  test("withholds a machine-converted one and falls to Simplified", () => {
    expect(pickSeoTitle(converted, "zh-Hant")).toBe("葬送的芙莉莲");
    // The visible title still shows the conversion — the two helpers are
    // supposed to disagree here, and that disagreement is the whole design.
    expect(pickTitle(converted, "zh-Hant")).toBe("葬送的芙莉蓮");
  });

  test("never reaches for titleHant, even when titleHantSeo is absent", () => {
    // An older go-api, or a response assembled before migration 0022, sends
    // no titleHantSeo. What must NOT happen is quietly reading the display
    // field as a substitute.
    //
    // Declared through a variable rather than passed as a literal on purpose:
    // SeoTitleBearing Omits titleHant, so a literal carrying it is an excess
    // property and will not compile. Real callers hand over an AnimeDetail,
    // which carries both fields and is not subject to that check — so this is
    // the shape the guarantee actually has to hold for.
    const fromOlderApi = { titleHant: "偷渡的標題", titleChinese: "备用" };
    expect(pickSeoTitle(fromOlderApi, "zh-Hant")).toBe("备用");
  });

  test("falls through to Japanese before English, like zh does", () => {
    expect(pickSeoTitle({ titleHantSeo: null, titleNative: "葬送のフリーレン", titleEnglish: "Frieren" }, "zh-Hant"))
      .toBe("葬送のフリーレン");
  });

  test("is identical to pickTitle for zh and en", () => {
    // Those two languages have no converted tier, so a divergence here would
    // be a bug rather than a feature.
    for (const lang of ["zh", "en"] as const) {
      expect(pickSeoTitle(human, lang)).toBe(pickTitle(human, lang));
      expect(pickSeoTitle(converted, lang)).toBe(pickTitle(converted, lang));
    }
  });

  test("returns empty string when every rung is missing", () => {
    expect(pickSeoTitle({}, "zh-Hant")).toBe("");
  });
});

describe("formatScore", () => {
  test("scales 0-100 to 0-10 string", () => {
    expect(formatScore(85)).toBe("8.5");
  });
  test("returns N/A for null", () => {
    expect(formatScore(null)).toBe("N/A");
  });
  test("returns N/A for 0", () => {
    expect(formatScore(0)).toBe("N/A");
  });
});

describe("stripHtml", () => {
  test("removes tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });
  test("returns empty string for null", () => {
    expect(stripHtml(null)).toBe("");
  });
});

describe("truncate", () => {
  test("appends ... when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });
  test("returns unchanged when under limit", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });
});

describe("pickCharacterName", () => {
  test("prefers nameCn for zh", () => {
    expect(
      pickCharacterName({ nameCn: "炭治郎", nameJa: "炭治郎", nameEn: "Tanjiro" }, "zh"),
    ).toBe("炭治郎");
  });

  test("falls back to nameJa when nameCn is absent for zh", () => {
    expect(pickCharacterName({ nameJa: "炭治郎", nameEn: "Tanjiro" }, "zh")).toBe(
      "炭治郎",
    );
  });

  test("falls back to nameEn when nameJa also absent for zh", () => {
    expect(pickCharacterName({ nameEn: "Tanjiro" }, "zh")).toBe("Tanjiro");
  });

  test("prefers nameEn for en", () => {
    expect(
      pickCharacterName({ nameCn: "炭治郎", nameJa: "炭治郎", nameEn: "Tanjiro" }, "en"),
    ).toBe("Tanjiro");
  });

  test("falls back to nameJa for en when nameEn absent", () => {
    expect(pickCharacterName({ nameJa: "炭治郎" }, "en")).toBe("炭治郎");
  });

  test("returns empty string when all fields missing", () => {
    expect(pickCharacterName({}, "zh")).toBe("");
    expect(pickCharacterName({}, "en")).toBe("");
  });
});

describe("pickVoiceActorName", () => {
  test("prefers voiceActorCn for zh", () => {
    expect(
      pickVoiceActorName(
        { voiceActorCn: "花江夏树", voiceActorJa: "Hanae", voiceActorEn: "Natsuki Hanae" },
        "zh",
      ),
    ).toBe("花江夏树");
  });

  test("falls back to voiceActorJa when Cn absent for zh", () => {
    expect(pickVoiceActorName({ voiceActorJa: "Hanae" }, "zh")).toBe("Hanae");
  });

  test("prefers voiceActorEn for en", () => {
    expect(
      pickVoiceActorName(
        { voiceActorCn: "花江夏树", voiceActorJa: "Hanae", voiceActorEn: "Natsuki Hanae" },
        "en",
      ),
    ).toBe("Natsuki Hanae");
  });

  test("returns empty string when all fields missing", () => {
    expect(pickVoiceActorName({}, "zh")).toBe("");
  });
});

describe("pickStaffName", () => {
  test("prefers nameJa for zh (JP names used for zh users per legacy decision)", () => {
    expect(
      pickStaffName({ nameEn: "Haruo Sotozaki", nameJa: "外崎春雄" }, "zh"),
    ).toBe("外崎春雄");
  });

  test("falls back to nameEn when nameJa absent for zh", () => {
    expect(pickStaffName({ nameEn: "Haruo Sotozaki" }, "zh")).toBe(
      "Haruo Sotozaki",
    );
  });

  test("prefers nameEn for en", () => {
    expect(
      pickStaffName({ nameEn: "Haruo Sotozaki", nameJa: "外崎春雄" }, "en"),
    ).toBe("Haruo Sotozaki");
  });

  test("falls back to nameJa for en when nameEn absent", () => {
    expect(pickStaffName({ nameJa: "外崎春雄" }, "en")).toBe("外崎春雄");
  });

  test("returns empty string when all fields missing", () => {
    expect(pickStaffName({}, "zh")).toBe("");
    expect(pickStaffName({}, "en")).toBe("");
  });
});

describe("pickDescription", () => {
  const EN = "A high school student finds a notebook that kills.";
  const CN = "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本。";

  test("prefers descriptionCn for zh and reports its provenance", () => {
    expect(
      pickDescription(
        { description: EN, descriptionCn: CN, descriptionCnSource: "bangumi" },
        "zh",
      ),
    ).toEqual({ text: CN, source: "bangumi" });
  });

  test("reports a null source for zh when descriptionCnSource is absent", () => {
    // Provenance is advisory — a Chinese body with no recorded source is
    // still rendered, it just carries no attribution.
    expect(pickDescription({ description: EN, descriptionCn: CN }, "zh")).toEqual({
      text: CN,
      source: null,
    });
  });

  test("falls back to English description for zh when descriptionCn is null", () => {
    // The zero-behaviour-change case: right after migration 0014 every row
    // has description_cn = NULL, so zh readers must still see exactly the
    // English text they saw before, with no provenance attached.
    expect(pickDescription({ description: EN, descriptionCn: null }, "zh")).toEqual({
      text: EN,
      source: null,
    });
  });

  test("falls back to English description for zh when descriptionCn is undefined", () => {
    // Payloads from every endpoint other than the detail one omit the field.
    expect(pickDescription({ description: EN }, "zh")).toEqual({
      text: EN,
      source: null,
    });
  });

  test("falls back to English description for zh when descriptionCn is an empty string", () => {
    expect(pickDescription({ description: EN, descriptionCn: "" }, "zh")).toEqual({
      text: EN,
      source: null,
    });
  });

  test("never carries a source through the fallback, even if one is set", () => {
    // A stale descriptionCnSource with no descriptionCn must not label the
    // English body as Bangumi-sourced.
    expect(
      pickDescription(
        { description: EN, descriptionCn: null, descriptionCnSource: "bangumi" },
        "zh",
      ),
    ).toEqual({ text: EN, source: null });
  });

  test("always takes description for en, even when descriptionCn is present", () => {
    // en readers must never be served the Chinese synopsis — this is the
    // property that keeps the channel invisible outside zh.
    //
    // This branch used to be unreachable from /anime/[id]: getLang() returned
    // "zh" for every server render, so no URL could produce an en detail page.
    // Since the route tree moved under app/[lang]/ it is live — /en/anime/21
    // resolves lang="en" from the path and lands here. A bare /anime/21 is
    // still zh, which is why this reads as a contract rather than a change.
    expect(
      pickDescription(
        { description: EN, descriptionCn: CN, descriptionCnSource: "bangumi" },
        "en",
      ),
    ).toEqual({ text: EN, source: null });
  });

  test("returns an empty text for en when only descriptionCn exists", () => {
    // en does not borrow from the Chinese slot as a fallback.
    expect(pickDescription({ description: null, descriptionCn: CN }, "en")).toEqual({
      text: "",
      source: null,
    });
  });

  test("returns an empty text, never null, when both fields are empty", () => {
    expect(pickDescription({ description: null, descriptionCn: null }, "zh")).toEqual({
      text: "",
      source: null,
    });
    expect(pickDescription({ description: null, descriptionCn: null }, "en")).toEqual({
      text: "",
      source: null,
    });
    expect(pickDescription({}, "zh")).toEqual({ text: "", source: null });
    expect(pickDescription({}, "en")).toEqual({ text: "", source: null });
  });
});

// ---------------------------------------------------------------------------
// descriptionCn wire contract
//
// pickDescription takes DescriptionBearing, whose fields are all optional, so
// `pickDescription(detail, lang)` in the detail page compiles whether or not
// AnimeDetail — and, upstream of it, the Go JSON — actually carries the
// Chinese slot. Every test above would still pass if the field never arrived:
// the object literals in this file supply it themselves.
//
// That makes a wire break silent in exactly the way `library.overflow.rescan`
// was silent (see locales/spaDictCoverage.test.ts): no exception, no warning,
// just zh readers pinned to the English description forever on the one page
// nobody diffs. So the contract gets pinned end to end the same way that one
// is — by reading the sources and asserting the names line up.
//
// `bunx tsc --noEmit` is not part of CI (unit-tests.yml runs `bun test`
// only), which is why the TS half is asserted at runtime here instead of
// being left to the type-level alias below.
// ---------------------------------------------------------------------------

/**
 * Compile-time half of the same contract: fails `tsc` the moment AnimeDetail
 * loses either field. Exported so it reads as deliberate rather than dead.
 */
type Assignable<T extends U, U> = T;
export type DescriptionCnWireContract = Assignable<
  AnimeDetail,
  { descriptionCn: string | null; descriptionCnSource: string | null }
>;

describe("descriptionCn wire contract", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");

  test("go-api serialises both fields under the names pickDescription reads", () => {
    // The detail struct is the only producer — the list endpoints omit these
    // two on purpose (a full synopsis per card would roughly double those
    // payloads), so this is deliberately scoped to detail.go.
    const detailGo = readFileSync(join(REPO, "go-api/internal/anime/detail.go"), "utf8");

    expect(detailGo).toContain('json:"descriptionCn"');
    expect(detailGo).toContain('json:"descriptionCnSource"');
  });

  test("AnimeDetail declares both fields", () => {
    // Guards the type-level alias above, which CI never evaluates.
    const types = readFileSync(join(import.meta.dir, "types.ts"), "utf8");

    expect(types).toContain("descriptionCn: string | null;");
    expect(types).toContain("descriptionCnSource: string | null;");
  });
});

// ---------------------------------------------------------------------------
// titleHant wire contract
//
// The title fields had no guard at all — descriptionCn got one because
// pickDescription's parameter type made the field optional, but a title is
// read positionally off `detail.titleChinese` all over the tree, so a rename
// upstream would surface as "the Traditional title silently stopped
// arriving" rather than as a type error.
//
// titleHantSeo is pinned separately from titleHant on purpose, and it is the
// more important of the two. It is the only field allowed into <title>,
// og:title and JSON-LD name, because the database projects the machine
// converted ('opencc') tier out of it — 85.3% sentence accuracy, with the
// misses correlating with popularity. If go-api ever stops emitting it, the
// SEO code silently falls back to a field that CAN carry a machine
// conversion, and Google learns the wrong name for the page. That is the
// failure this assertion exists to make loud.
// ---------------------------------------------------------------------------

describe("titleHant wire contract", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");

  test("go-api serialises the hant title fields under the names the client reads", () => {
    const detailGo = readFileSync(join(REPO, "go-api/internal/anime/detail.go"), "utf8");

    expect(detailGo).toContain('json:"titleHant"');
    expect(detailGo).toContain('json:"titleHantSeo"');
  });

  test("AnimeDetail declares both fields", () => {
    const types = readFileSync(join(import.meta.dir, "types.ts"), "utf8");

    expect(types).toContain("titleHant?: string | null;");
    expect(types).toContain("titleHantSeo?: string | null;");
  });
});

// ---------------------------------------------------------------------------
// episodesBgm wire contract, and R3.
//
// AniList leaves `episodes` NULL for a large slice of the catalogue — most of
// what is currently airing. Migration 0023 added a second column,
// `episodes_bgm`, that a sweep fills from an external episode source, and the
// detail endpoint now returns both as two separate fields.
//
// Two fields rather than one fallback, because the two consumers on the detail
// route are not making the same kind of statement:
//
//   the badge and the episode grid   text on a page, which a reader sees in
//                                    context and which the page can qualify
//   schema.org numberOfEpisodes      a machine-readable claim about the work,
//                                    addressed to a search engine that treats
//                                    it as fact and may surface it away from
//                                    the page entirely
//
// The first may fall back to the inferred count. The second may not. That is
// R3, and it survives only as long as the two values stay distinguishable all
// the way down — SQL projection, Go DTO, TypeScript type, call site. A merge
// at any layer leaves every call site below it looking identical, and the one
// that has to refuse the guess loses the means to.
//
// The behavioural half runs against the real builder. buildJsonLd lives in
// @/components/anime/animeJsonLd rather than in page.tsx precisely so it can:
// nothing can import that page (`page.tsx -> DetailActions -> Subscription-
// Button -> react-hot-toast`, which touches `document` at module scope — see
// testImportHygiene.test.ts).
// ---------------------------------------------------------------------------

/**
 * Compile-time half: `AnimeDetail["episodesBgm"]` stops resolving the moment
 * the field is dropped from the type, and the alias stops compiling if it ever
 * becomes something other than a count.
 */
export type EpisodesBgmWireContract = Assignable<
  NonNullable<AnimeDetail["episodesBgm"]>,
  number
>;

/**
 * A detail row carrying only what buildJsonLd reads. Cast rather than spelled
 * out in full: the subject here is the builder's behaviour, and AnimeDetail's
 * completeness is the alias above's job.
 */
function detailRow(over: Partial<AnimeDetail>): AnimeDetail {
  return {
    anilistId: 1,
    titleRomaji: "Sousou no Frieren",
    titleEnglish: null,
    titleNative: null,
    titleChinese: null,
    coverImageUrl: null,
    description: null,
    episodes: null,
    episodesBgm: null,
    startDate: null,
    genres: [],
    studios: [],
    bangumiScore: null,
    bangumiVotes: null,
    ...over,
  } as AnimeDetail;
}

describe("episodesBgm wire contract", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");

  test("the detail query projects both counts, and coalesces neither", () => {
    const sql = readFileSync(
      join(REPO, "go-api/internal/db/queries/anime_cache.sql"),
      "utf8",
    );
    const start = sql.indexOf("-- name: GetAnimeMainByID :one");
    expect(start).toBeGreaterThan(-1);
    const next = sql.indexOf("-- name: ", start + 1);
    const query = sql.slice(start, next === -1 ? undefined : next);

    expect(query).toContain("    episodes,");
    expect(query).toContain("    episodes_bgm,");
    // A COALESCE in the projection is the one edit that would defeat every
    // guard below it, because everything downstream would still typecheck.
    expect(query).not.toContain("COALESCE(episodes");
    expect(query).not.toContain("coalesce(episodes");
  });

  test("go-api serialises the two counts under separate names", () => {
    const detailGo = readFileSync(join(REPO, "go-api/internal/anime/detail.go"), "utf8");

    expect(detailGo).toContain('json:"episodes"');
    expect(detailGo).toContain('json:"episodesBgm"');
  });

  test("AnimeDetail declares both fields", () => {
    // Guards the type-level alias above, which CI never evaluates.
    const types = readFileSync(join(import.meta.dir, "types.ts"), "utf8");

    expect(types).toContain("episodes: number | null;");
    expect(types).toContain("episodesBgm?: number | null;");
  });
});

describe("R3 — only the authoritative count reaches schema.org", () => {
  test("an inferred count produces no numberOfEpisodes at all", () => {
    // The load-bearing assertion. Currently airing: AniList has no total, the
    // sweep inferred 24. An absent numberOfEpisodes says nothing about the
    // work; a guessed one says something false, and says it to a machine.
    const ld = buildJsonLd(detailRow({ episodes: null, episodesBgm: 24 }), "zh");

    expect(ld).not.toHaveProperty("numberOfEpisodes");
    expect(JSON.stringify(ld)).not.toContain("numberOfEpisodes");
  });

  test("the same row still gives the badge and the grid a number to draw", () => {
    // The point of keeping two fields, stated as one comparison: one input
    // row, two consumers, two different answers. If a later change merges the
    // fields, this pair collapses into agreement and the assertion above is
    // the one that breaks.
    const row = detailRow({ episodes: null, episodesBgm: 24 });

    expect(resolveEpisodeSkeleton(row.episodes, row.episodesBgm ?? null, [])).toEqual({
      kind: "inferred",
      total: 24,
    });
    expect(buildJsonLd(row, "zh")).not.toHaveProperty("numberOfEpisodes");
  });

  test("both counts present publishes the authoritative one, not the inferred", () => {
    // The sources disagree, which they do whenever a season is mid-flight.
    // AniList's 12 is the claim; the sweep's 13 must not reach schema.org
    // even though it is the larger and more recent number.
    const ld = buildJsonLd(detailRow({ episodes: 12, episodesBgm: 13 }), "zh");

    expect(ld.numberOfEpisodes).toBe(12);
  });

  test("an authoritative count alone is published as before", () => {
    // Regression guard: the ordinary finished-show path is untouched.
    expect(buildJsonLd(detailRow({ episodes: 26 }), "zh").numberOfEpisodes).toBe(26);
    expect(buildJsonLd(detailRow({ episodes: 26 }), "en").numberOfEpisodes).toBe(26);
  });

  test("neither count present omits the property rather than emitting zero", () => {
    // `numberOfEpisodes: 0` would be a claim that the show has no episodes.
    const ld = buildJsonLd(detailRow({ episodes: null, episodesBgm: null }), "zh");

    expect(ld).not.toHaveProperty("numberOfEpisodes");
  });
});

describe("formatFuzzyDate (zh locale)", () => {
  test("formats YYYY年MM月DD日 for zh with full date", () => {
    expect(formatFuzzyDate({ year: 2021, month: 12, day: 5 }, "zh")).toBe(
      "2021年12月5日",
    );
  });

  test("formats YYYY年MM月 for zh when day is missing", () => {
    expect(formatFuzzyDate({ year: 2024, month: 7, day: null }, "zh")).toBe(
      "2024年7月",
    );
  });

  test("formats YYYY年 for zh when only year is present", () => {
    expect(formatFuzzyDate({ year: 2020, month: null, day: null }, "zh")).toBe(
      "2020年",
    );
  });

  test("passes through an ISO string without double-formatting", () => {
    // String input is parsed and re-formatted in zh style
    expect(formatFuzzyDate("2021-12-05", "zh")).toBe("2021年12月5日");
  });

  test("passes through a non-parseable string as-is (no year to format)", () => {
    // When the string does not match the YYYY[-MM[-DD]] pattern the helper
    // returns the original string unchanged rather than null.
    expect(formatFuzzyDate("not-a-date")).toBe("not-a-date");
  });
});

// The collapsed-description budget is measured in visual width rather than
// characters because a character means something different in each script.
// These cases encode the real corpus this was derived from: harvested Chinese
// summaries run 55-289 characters while their English counterparts run
// 235-1100, so a shared character threshold put every Chinese summary below
// the cut and every English one above it — the read-more control only ever
// appeared for English readers.
describe("visualWidth", () => {
  test("counts latin characters as one unit each", () => {
    expect(visualWidth("abcde")).toBe(5);
  });

  test("counts CJK ideographs as two units each", () => {
    // 6 Han characters -> 12, matching their ~2x rendered width.
    expect(visualWidth("葬送的芙莉莲")).toBe(12);
  });

  test("counts kana and fullwidth punctuation as CJK", () => {
    expect(visualWidth("フリーレン")).toBe(10);
    expect(visualWidth("！？")).toBe(4);
  });

  test("measures mixed scripts additively", () => {
    // "攻壳机动队" (5 Han = 10) + " GHOST" (6 latin = 6).
    expect(visualWidth("攻壳机动队 GHOST")).toBe(16);
  });

  test("treats null, undefined and empty as zero", () => {
    expect(visualWidth(null)).toBe(0);
    expect(visualWidth(undefined)).toBe(0);
    expect(visualWidth("")).toBe(0);
  });

  test("a real Chinese summary outweighs its character count", () => {
    // 未截断的中文简介：字符数看着不多，占的版面却是两倍。
    const zh = "魔法使芙莉莲和勇者辛美尔等人一起，历经十年的冒险之后击败了魔王，为世界带来了和平。";
    expect(zh.length).toBeLessThan(60);
    expect(visualWidth(zh)).toBeGreaterThan(80);
  });
});

describe("truncateVisual", () => {
  test("returns the string untouched when it fits", () => {
    expect(truncateVisual("short", 300)).toBe("short");
    expect(truncateVisual("葬送的芙莉莲", 300)).toBe("葬送的芙莉莲");
  });

  test("cuts latin text at the same point a character count would", () => {
    // Latin counts one per character, so width and length agree here — this
    // is what keeps the English rendering byte-identical to the old helper.
    const s = "a".repeat(400);
    expect(truncateVisual(s, 300)).toBe("a".repeat(300) + "...");
  });

  test("cuts CJK text at half the character count", () => {
    const s = "字".repeat(400);
    // 300 units of budget buys 150 双宽 characters.
    expect(truncateVisual(s, 300)).toBe("字".repeat(150) + "...");
  });

  test("never splits a character to use up an odd remaining unit", () => {
    // Budget 5 fits two CJK characters (4 units); the fifth unit is left
    // unused rather than emitting half a glyph.
    expect(truncateVisual("一二三四", 5)).toBe("一二...");
  });

  test("handles mixed scripts without overshooting the budget", () => {
    const out = truncateVisual("攻壳机动队 GHOST IN THE SHELL", 16);
    expect(visualWidth(out.replace(/\.\.\.$/, ""))).toBeLessThanOrEqual(16);
    expect(out.endsWith("...")).toBe(true);
  });

  test("treats null and undefined as empty", () => {
    expect(truncateVisual(null, 300)).toBe("");
    expect(truncateVisual(undefined, 300)).toBe("");
  });

  test("the toggle decision matches the truncation decision", () => {
    // A string that fits must never be truncated, and one that is truncated
    // must report as needing the toggle — otherwise the control appears
    // above untruncated text or is missing above an elided one.
    for (const s of ["短", "葬送的芙莉莲".repeat(30), "a".repeat(299), "a".repeat(301)]) {
      const needsToggle = visualWidth(s) > 300;
      const truncated = truncateVisual(s, 300);
      expect(truncated !== s).toBe(needsToggle);
    }
  });
});
