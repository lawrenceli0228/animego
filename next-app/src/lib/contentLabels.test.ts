import { describe, expect, test } from "bun:test";
import {
  FILTER_GENRES,
  FORMAT_LABEL,
  GENRE_LABEL,
  STAFF_ROLE_LABEL,
  STATUS_LABEL,
  formatLabel,
  genreLabel,
  normalizeStaffRole,
  pickRelatedTitle,
  staffRoleLabel,
  statusLabel,
} from "./contentLabels";
import { LANGS, type Lang } from "./i18n/lang";

/**
 * Languages that deliberately render AniList's own English strings for genre
 * and staff role, cross-checked against the module's own `null` declarations
 * below.
 *
 * Hand-maintained on purpose. Every table in contentLabels.ts is
 * `Record<Lang, …>`, so a third language cannot COMPILE without stating an
 * answer — but `en: null` and `"zh-Hant": null` cost the same keystrokes, and
 * the second one is almost certainly wrong (a Traditional reader wants the zh
 * table converted, not English). This list makes "I read AniList raw" a thing
 * someone has to write down twice, in two files, one of which is a test.
 */
const IDENTITY_LANGS: readonly Lang[] = ["en"];

/** The complement: languages that must carry a full label table. */
const TRANSLATED_LANGS: readonly Lang[] = LANGS.filter(
  (l) => !IDENTITY_LANGS.includes(l),
);

/**
 * The genre vocabulary observed in prod `anime_genres` on 2026-08-06
 * (17,304 rows). This list is a FROZEN SNAPSHOT, deliberately re-typed here
 * rather than derived from GENRE_LABEL — deriving it would make the coverage
 * test tautological. When AniList introduces a new genre the enrichment job
 * will start writing it, someone adds it here, and CI then fails until a
 * Chinese label exists. Without this gate a new genre renders raw English
 * inside an otherwise-Chinese chip row and nobody notices.
 */
const PROD_GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Ecchi",
  "Fantasy",
  "Hentai",
  "Horror",
  "Mahou Shoujo",
  "Mecha",
  "Music",
  "Mystery",
  "Psychological",
  "Romance",
  "Sci-Fi",
  "Slice of Life",
  "Sports",
  "Supernatural",
  "Thriller",
] as const;

/** Matches any CJK ideograph — used to prove no zh label leaks into en. */
const CJK = /[㐀-䶿一-鿿]/;

describe("every language declares how it labels content enums", () => {
  // The gate that makes a third language a decision instead of a default.
  // tsc forces a new Lang to appear in all four tables; these two tests force
  // the *value* it was given to be one someone signed off on.
  test("only the vetted languages fall back to AniList's raw English", () => {
    const declared = LANGS.filter(
      (l) => GENRE_LABEL[l] === null || STAFF_ROLE_LABEL[l] === null,
    );
    expect([...declared].sort()).toEqual([...IDENTITY_LANGS].sort());
  });

  test("format and status are translated for every language — neither is ever raw", () => {
    // These two enums have no identity language at all: SPECIAL / HIATUS are
    // database enums, not prose, and shipping "NOT_YET_RELEASED" into a chip
    // is a bug in any language including English.
    for (const lang of LANGS) {
      expect(FORMAT_LABEL[lang]).not.toBeNull();
      expect(STATUS_LABEL[lang]).not.toBeNull();
    }
  });
});

describe("GENRE_LABEL coverage", () => {
  for (const lang of TRANSLATED_LANGS) {
    test(`every genre present in prod has a ${lang} label`, () => {
      const missing = PROD_GENRES.filter((g) => !(g in GENRE_LABEL[lang]));
      expect(missing).toEqual([]);
    });

    test(`no ${lang} label is empty, blank, or an echo of the English key`, () => {
      for (const genre of PROD_GENRES) {
        const label = GENRE_LABEL[lang][genre];
        expect(label).toBeTruthy();
        expect(label.trim()).not.toBe("");
        expect(label).not.toBe(genre);
      }
    });

    test(`the ${lang} map holds exactly the prod vocabulary — no dead or invented keys`, () => {
      expect(Object.keys(GENRE_LABEL[lang]).sort()).toEqual([...PROD_GENRES].sort());
    });

    test(`genreLabel resolves every prod genre to its ${lang} label`, () => {
      for (const genre of PROD_GENRES) {
        expect(genreLabel(genre, lang)).toBe(GENRE_LABEL[lang][genre]);
      }
    });
  }

  test("genreLabel passes an unknown genre through untranslated rather than blanking it", () => {
    for (const lang of LANGS) {
      expect(genreLabel("Isekai", lang)).toBe("Isekai");
    }
  });
});

describe("FILTER_GENRES", () => {
  test("is a subset of GENRE_LABEL.zh, so every chip can render Chinese", () => {
    const unlabelled = FILTER_GENRES.filter((g) => !(g in GENRE_LABEL.zh));
    expect(unlabelled).toEqual([]);
  });

  test("intentionally excludes Hentai — a real catalogue value, not a browse filter", () => {
    // Hentai must stay OUT of the filter chips but IN the label map, because
    // detail pages still have to render the genre when a title carries it.
    expect(FILTER_GENRES).not.toContain("Hentai");
    expect(GENRE_LABEL.zh).toHaveProperty("Hentai");
  });

  test("is exactly GENRE_LABEL.zh minus Hentai (18 of 19)", () => {
    expect(FILTER_GENRES).toHaveLength(18);
    // Widened to string[]: FILTER_GENRES is a literal-union tuple, and toEqual
    // infers its expected type from the received side.
    const actual: string[] = [...FILTER_GENRES];
    const expected = Object.keys(GENRE_LABEL.zh)
      .filter((g) => g !== "Hentai")
      .sort();
    expect(actual.sort()).toEqual(expected);
  });

  test("holds no duplicates", () => {
    expect(new Set(FILTER_GENRES).size).toBe(FILTER_GENRES.length);
  });
});

describe("English must not regress", () => {
  // The hard constraint on this whole change: for lang="en" the output has to
  // be byte-identical to what shipped before the zh work. genre and staff role
  // were raw AniList strings, so en is the strict identity. format and status
  // were already localised through hardcoded maps in SeasonalFilterChips.tsx,
  // so their baseline is those exact labels — re-typed below so that editing
  // FORMAT_LABEL.en / STATUS_LABEL.en cannot quietly move the English UI.
  //
  // The identity assertions now run over IDENTITY_LANGS rather than a literal
  // "en", so a language that declares itself an identity language inherits the
  // same guarantee automatically. The frozen-string assertions stay pinned to
  // "en": those are a record of what the English UI shipped, and there is no
  // such record for any other language.

  /** Verbatim from the pre-refactor SeasonalFilterChips FORMAT_LABELS.en. */
  const FROZEN_EN_FORMAT: Record<string, string> = {
    TV: "TV",
    TV_SHORT: "Short",
    MOVIE: "Movie",
    SPECIAL: "Special",
    OVA: "OVA",
    ONA: "ONA",
    // MUSIC had no entry pre-refactor (it was absent from the chip list), so
    // there is no prior English string to preserve — "Music" is net-new.
    MUSIC: "Music",
  };

  /** Verbatim from the pre-refactor SeasonalFilterChips STATUS_LABELS.en. */
  const FROZEN_EN_STATUS: Record<string, string> = {
    RELEASING: "Airing",
    FINISHED: "Finished",
    NOT_YET_RELEASED: "Upcoming",
    // CANCELLED / HIATUS were never rendered pre-refactor — also net-new.
    CANCELLED: "Cancelled",
    HIATUS: "Hiatus",
  };

  test("genreLabel is the identity for every known genre", () => {
    for (const lang of IDENTITY_LANGS) {
      for (const genre of Object.keys(GENRE_LABEL.zh)) {
        expect(genreLabel(genre, lang)).toBe(genre);
      }
    }
  });

  test("genreLabel is the identity for unknown genres too", () => {
    for (const lang of IDENTITY_LANGS) {
      for (const genre of ["Isekai", "", "  ", "Sci-Fi ", "不存在"]) {
        expect(genreLabel(genre, lang)).toBe(genre);
      }
    }
  });

  test("staffRoleLabel is the identity for every known role", () => {
    for (const lang of IDENTITY_LANGS) {
      for (const role of Object.keys(STAFF_ROLE_LABEL.zh)) {
        expect(staffRoleLabel(role, lang)).toBe(role);
      }
    }
  });

  test("staffRoleLabel is the identity for qualified and unknown roles", () => {
    const roles = [
      "Episode Director (eps 3, 7)",
      "Theme Song Performance (ED)",
      // Numbered song qualifiers exercise the qualifier regex hardest. An
      // identity language must stay the identity no matter how that regex is
      // tuned: staffRoleLabel does run the regex now (it dropped the early
      // `lang !== "zh"` return), so the guarantee rests on the language having
      // no table at all rather than on statement order. Same assertion, but it
      // is now load-bearing for a reason it was not before.
      "Theme Song Performance (ED2)",
      "Theme Song Performance (OP1)",
      "Key Animation (12 episodes)",
      "ADR Director (English)",
      "Setting Manager",
      "",
    ];
    for (const lang of IDENTITY_LANGS) {
      for (const role of roles) {
        expect(staffRoleLabel(role, lang)).toBe(role);
      }
    }
  });

  test("formatLabel matches the frozen English labels exactly", () => {
    for (const [format, label] of Object.entries(FROZEN_EN_FORMAT)) {
      expect(formatLabel(format, "en")).toBe(label);
    }
  });

  test("statusLabel matches the frozen English labels exactly", () => {
    for (const [status, label] of Object.entries(FROZEN_EN_STATUS)) {
      expect(statusLabel(status, "en")).toBe(label);
    }
  });

  test("formatLabel and statusLabel pass unknown values through in en", () => {
    expect(formatLabel("MANGA", "en")).toBe("MANGA");
    expect(statusLabel("PAUSED", "en")).toBe("PAUSED");
  });

  test("no helper can leak a Chinese label into an identity language's output", () => {
    const probes: Array<[string, (v: string, l: Lang) => string]> = [
      ...Object.keys(GENRE_LABEL.zh).map(
        (k) => [k, genreLabel] as [string, typeof genreLabel],
      ),
      ...Object.keys(FORMAT_LABEL.zh).map(
        (k) => [k, formatLabel] as [string, typeof formatLabel],
      ),
      ...Object.keys(STATUS_LABEL.zh).map(
        (k) => [k, statusLabel] as [string, typeof statusLabel],
      ),
      ...Object.keys(STAFF_ROLE_LABEL.zh).map(
        (k) => [k, staffRoleLabel] as [string, typeof staffRoleLabel],
      ),
    ];
    for (const lang of IDENTITY_LANGS) {
      for (const [value, fn] of probes) {
        expect(fn(value, lang)).not.toMatch(CJK);
      }
    }
  });
});

describe("formatLabel", () => {
  const cases: Array<[string, string]> = [
    ["TV", "TV"],
    ["TV_SHORT", "TV 短篇"],
    ["MOVIE", "剧场版"],
    ["SPECIAL", "特别篇"],
    ["OVA", "OVA"],
    ["ONA", "ONA"],
    // MUSIC was missing from the old chip map, so 1,207 music videos rendered
    // the raw enum. This row is the regression guard for that.
    ["MUSIC", "音乐 MV"],
  ];

  test("covers all seven prod formats in zh", () => {
    expect(cases).toHaveLength(7);
    for (const [format, zh] of cases) {
      expect(formatLabel(format, "zh")).toBe(zh);
    }
  });

  test("the zh map holds exactly those seven keys", () => {
    expect(Object.keys(FORMAT_LABEL.zh).sort()).toEqual(cases.map(([f]) => f).sort());
  });

  test("every language covers all seven formats — no raw enum in any UI", () => {
    // FORMAT_LABEL has no identity language, so a partially-filled table for a
    // new language is a real user-visible bug (a "SPECIAL" chip in a
    // translated row) that tsc cannot see: the tables are Record<string, …>.
    for (const lang of LANGS) {
      const missing = cases.map(([f]) => f).filter((f) => !(f in FORMAT_LABEL[lang]));
      expect(missing).toEqual([]);
    }
  });

  test("TV / OVA / ONA are intentionally identical in both languages", () => {
    for (const format of ["TV", "OVA", "ONA"]) {
      expect(formatLabel(format, "zh")).toBe(format);
      expect(formatLabel(format, "en")).toBe(format);
    }
  });

  test("passes an unknown format through in zh", () => {
    expect(formatLabel("MANGA", "zh")).toBe("MANGA");
  });
});

describe("statusLabel", () => {
  test("translates every airing status in zh", () => {
    expect(statusLabel("RELEASING", "zh")).toBe("连载中");
    expect(statusLabel("FINISHED", "zh")).toBe("已完结");
    expect(statusLabel("NOT_YET_RELEASED", "zh")).toBe("未开播");
    expect(statusLabel("CANCELLED", "zh")).toBe("已取消");
    expect(statusLabel("HIATUS", "zh")).toBe("休载中");
  });

  const ANILIST_STATUSES = [
    "CANCELLED",
    "FINISHED",
    "HIATUS",
    "NOT_YET_RELEASED",
    "RELEASING",
  ];

  test("the map holds exactly the five AniList statuses", () => {
    expect(Object.keys(STATUS_LABEL.zh).sort()).toEqual([...ANILIST_STATUSES].sort());
  });

  test("every language covers all five statuses — see the FORMAT_LABEL sibling", () => {
    for (const lang of LANGS) {
      const missing = ANILIST_STATUSES.filter((s) => !(s in STATUS_LABEL[lang]));
      expect(missing).toEqual([]);
    }
  });

  test("passes an unknown status through in zh", () => {
    expect(statusLabel("PAUSED", "zh")).toBe("PAUSED");
  });
});

describe("normalizeStaffRole", () => {
  // Real values sampled from prod `anime_staff.role` (4,794 distinct raw
  // strings). Episode / theme-song qualifiers are noise for lookup and must be
  // stripped; a parenthetical that changes the MEANING of the role must not be.
  const cases: Array<[string, string]> = [
    ["Episode Director (eps 3, 7)", "Episode Director"],
    ["Theme Song Performance (ED)", "Theme Song Performance"],
    ["Theme Song Performance (OP1)", "Theme Song Performance"],
    ["Key Animation (12 episodes)", "Key Animation"],
    // Not a qualifier: "(English)" distinguishes the English-dub director from
    // the Japanese one, so stripping it would merge two different credits.
    ["ADR Director (English)", "ADR Director (English)"],
    ["Director", "Director"],
  ];

  for (const [raw, expected] of cases) {
    test(`"${raw}" -> "${expected}"`, () => {
      expect(normalizeStaffRole(raw)).toBe(expected);
    });
  }

  test("is idempotent — normalising an already-clean role is a no-op", () => {
    for (const [raw] of cases) {
      const once = normalizeStaffRole(raw);
      expect(normalizeStaffRole(once)).toBe(once);
    }
  });

  test("collapses the whitespace left behind by a stripped qualifier", () => {
    expect(normalizeStaffRole("Key Animation (eps 1)")).not.toMatch(/\s{2,}|\s$/);
  });

  test("the module-level /g regex is not stateful across calls", () => {
    // A shared global RegExp can carry lastIndex between calls; two identical
    // calls in a row must not disagree.
    const first = normalizeStaffRole("Episode Director (eps 3, 7)");
    const second = normalizeStaffRole("Episode Director (eps 3, 7)");
    expect(second).toBe(first);
  });
});

describe("staffRoleLabel", () => {
  test("translates a plain role in zh", () => {
    expect(staffRoleLabel("Director", "zh")).toBe("监督");
    expect(staffRoleLabel("Key Animation", "zh")).toBe("原画");
  });

  test("translates the role but keeps the episode qualifier attached", () => {
    // The qualifier is data the reader needs (which episodes this credit
    // covers), so translating must not silently drop it.
    const out = staffRoleLabel("Episode Director (eps 3, 7)", "zh");
    expect(out).toContain("演出");
    expect(out).toContain("(eps 3, 7)");
    expect(out).not.toContain("Episode Director");
  });

  test("keeps a theme-song qualifier attached", () => {
    const out = staffRoleLabel("Theme Song Performance (ED)", "zh");
    expect(out).toContain("主题曲演唱");
    expect(out).toContain("(ED)");
  });

  test("keeps a NUMBERED theme-song qualifier attached", () => {
    // Sibling of the red normalizeStaffRole case, kept separate because it
    // pins the user-visible symptom rather than the helper: a numbered OP/ED
    // that fails to normalise never reaches STAFF_ROLE_LABEL, so the credit
    // renders as raw English inside an otherwise-Chinese staff list. Numbered
    // qualifiers are the norm for theme-song credits, not an edge case.
    for (const [raw, qualifier] of [
      ["Theme Song Performance (ED2)", "(ED2)"],
      ["Theme Song Performance (OP1)", "(OP1)"],
    ]) {
      const out = staffRoleLabel(raw, "zh");
      expect(out).toContain("主题曲演唱");
      expect(out).toContain(qualifier);
      expect(out).not.toContain("Theme Song Performance");
    }
  });

  test("returns an unknown role verbatim rather than blanking it", () => {
    expect(staffRoleLabel("Setting Manager", "zh")).toBe("Setting Manager");
    expect(staffRoleLabel("Setting Manager (eps 4)", "zh")).toBe(
      "Setting Manager (eps 4)",
    );
  });

  test("matches a meaningful parenthetical whole", () => {
    expect(staffRoleLabel("ADR Director (English)", "zh")).toBe("英语配音监督");
  });
});

describe("pickRelatedTitle", () => {
  const both = { title: "Kimi no Na wa.", titleChinese: "你的名字。" };

  test("zh prefers the Chinese title", () => {
    expect(pickRelatedTitle(both, "zh")).toBe("你的名字。");
  });

  test("en prefers the romaji title", () => {
    expect(pickRelatedTitle(both, "en")).toBe("Kimi no Na wa.");
  });

  test("zh falls back to romaji when no Chinese title exists", () => {
    expect(pickRelatedTitle({ title: "Kimi no Na wa." }, "zh")).toBe("Kimi no Na wa.");
    expect(pickRelatedTitle({ title: "Kimi no Na wa.", titleChinese: null }, "zh")).toBe(
      "Kimi no Na wa.",
    );
  });

  test("en falls back to the Chinese title when no romaji exists", () => {
    expect(pickRelatedTitle({ titleChinese: "你的名字。" }, "en")).toBe("你的名字。");
    expect(pickRelatedTitle({ title: null, titleChinese: "你的名字。" }, "en")).toBe(
      "你的名字。",
    );
  });

  test("returns an empty string when both titles are missing", () => {
    for (const lang of LANGS) {
      expect(pickRelatedTitle({}, lang)).toBe("");
      expect(pickRelatedTitle({ title: null, titleChinese: null }, lang)).toBe("");
      expect(pickRelatedTitle({ title: "", titleChinese: "" }, lang)).toBe("");
    }
  });

  test("treats a whitespace-only title as missing", () => {
    expect(pickRelatedTitle({ title: "Bakemonogatari", titleChinese: "   " }, "zh")).toBe(
      "Bakemonogatari",
    );
    expect(pickRelatedTitle({ title: "   ", titleChinese: "化物语" }, "en")).toBe("化物语");
    expect(pickRelatedTitle({ title: "  ", titleChinese: "  " }, "zh")).toBe("");
  });

  test("trims the title it returns", () => {
    expect(pickRelatedTitle({ titleChinese: "  你的名字。  " }, "zh")).toBe("你的名字。");
  });
});
