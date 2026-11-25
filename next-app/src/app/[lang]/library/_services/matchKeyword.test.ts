import { describe, expect, test } from "bun:test";
import { buildMatchKeyword } from "./matchKeyword";

// The keyword is what /api/dandanplay/match searches by when the file hash is
// not indexed: anime_cache first, then dandanplay's own search. go-api reads
// a season only from wording like "Season 3", "3rd Season" or "第三季" — not
// "S3" — and uses it as a hard gate, so a later season has to be spelled out.

describe("buildMatchKeyword", () => {
  test("a first or unstated season sends the title alone", () => {
    expect(buildMatchKeyword("Nama-Anaru", 1)).toBe("Nama-Anaru");
    expect(buildMatchKeyword("Nama-Anaru", null)).toBe("Nama-Anaru");
    expect(buildMatchKeyword("Nama-Anaru", undefined)).toBe("Nama-Anaru");
  });

  test("★ a later season is spelled the way go-api's season gate reads it", () => {
    expect(buildMatchKeyword("Kusuriya", 3)).toBe("Kusuriya Season 3");
    expect(buildMatchKeyword("Ao Ashi", 2)).toBe("Ao Ashi Season 2");
  });

  test("a title that already names its season is left as it is", () => {
    expect(buildMatchKeyword("葬送的芙莉蓮 第二季", 2)).toBe("葬送的芙莉蓮 第二季");
    expect(buildMatchKeyword("無職轉生～到了異世界就拿出真本事～第三季", 3)).toBe(
      "無職轉生～到了異世界就拿出真本事～第三季",
    );
    expect(buildMatchKeyword("Re：Zero kara Hajimeru Isekai Seikatsu 4th Season", 4)).toBe(
      "Re：Zero kara Hajimeru Isekai Seikatsu 4th Season",
    );
    expect(buildMatchKeyword("Sono Bisque Doll wa Koi wo Suru Season 2", 2)).toBe(
      "Sono Bisque Doll wa Koi wo Suru Season 2",
    );
    expect(buildMatchKeyword("Youjo Senki II", 2)).toBe("Youjo Senki II");
  });

  test("no title, no keyword", () => {
    expect(buildMatchKeyword(null, 2)).toBe("");
    expect(buildMatchKeyword(undefined, null)).toBe("");
    expect(buildMatchKeyword("   ", 3)).toBe("");
  });

  test("surrounding whitespace is dropped", () => {
    expect(buildMatchKeyword("  Ao Ashi ", 2)).toBe("Ao Ashi Season 2");
  });
});
