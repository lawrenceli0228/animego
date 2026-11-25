import { describe, expect, test } from "bun:test";

import {
  parseAbsoluteEpisode,
  parseAnimeKeyword,
  parseEpisodeMeta,
  parseEpisodeNumber,
  parseSeason,
} from "./episodeParser";

// episodeParser is where every local episode number in the product is born,
// and until now it had no tests at all. Five ordered regexes, a resolution
// blacklist and a scrubbed digit fallback decide what `Episode.number` is for
// every file anyone imports, and nothing pinned any of it.
//
// Two jobs here. The first block is a regression net for behaviour that
// already existed: the pattern table was lifted out of `parseEpisodeNumber`
// into a module constant so each entry could carry which numbering it proves,
// and a refactor of the one function nobody was testing is exactly the kind
// that goes wrong quietly. The second block pins the new fact — `numberSpace`
// — and most of its cases assert that the parser says "unknown", because
// admitting ignorance is the whole point of the field.

describe("parseEpisodeNumber — the behaviour the pattern table has to preserve", () => {
  test("S01E03 reads the episode, not the season", () => {
    expect(parseEpisodeNumber("[Sakurato] Frieren [S02E03][1080p].mkv")).toBe(3);
  });

  test("EP03 / E03 / EP 03 all read 3", () => {
    expect(parseEpisodeNumber("Show EP03.mkv")).toBe(3);
    expect(parseEpisodeNumber("Show E03.mkv")).toBe(3);
    expect(parseEpisodeNumber("Show EP 03.mkv")).toBe(3);
  });

  test("★ the word boundary before E is load-bearing", () => {
    // Without `\b`, the `e 2` inside this title matched and collapsed all
    // seven files of the cluster onto episode 2.
    expect(parseEpisodeNumber("[Group] Class de 2-banme [05][1080p].mkv")).toBe(5);
  });

  test("第03話 / 第3集 read the CJK episode marker", () => {
    expect(parseEpisodeNumber("[NC-Raws] 鬼滅 [第03話][WebRip 1080p].mkv")).toBe(3);
    expect(parseEpisodeNumber("某番 第3集.mp4")).toBe(3);
  });

  test("a dash-delimited number reads, including a four-digit one", () => {
    expect(parseEpisodeNumber("[Lilith-Raws] One Piece - 1091 [1080p].mkv")).toBe(1091);
  });

  test("a bracketed number reads, with or without a version suffix", () => {
    expect(parseEpisodeNumber("[VCB] Steins Gate [12][Ma10p_1080p].mkv")).toBe(12);
    expect(parseEpisodeNumber("[Group] Show [07v2][1080p].mkv")).toBe(7);
  });

  test("★ a resolution is never an episode number", () => {
    // The blacklist skips to the NEXT pattern rather than giving up, so the
    // real number behind a resolution-shaped match still has to be found.
    expect(parseEpisodeNumber("[Group] Show [1080][BDRip].mkv")).toBeNull();
    expect(parseEpisodeNumber("[Group] Show [1080p][05].mkv")).toBe(5);
  });

  test("★ codec tokens are scrubbed before the bare-digit fallback", () => {
    // `10bit` → episode 10 would let a BD extra steal the main lane's slot.
    expect(parseEpisodeNumber("[NCOP1][1080P][HEVC-10bit][FLAC].mkv")).toBeNull();
    expect(parseEpisodeNumber("Show 24 [x265][FLAC].mkv")).toBe(24);
  });

  test("a filename with no number at all is null, not zero", () => {
    expect(parseEpisodeNumber("[Group] Show [Menu][1080p].mkv")).toBeNull();
  });
});

describe("numberSpace — what the filename can actually prove", () => {
  test("★ S01E03 is the one format that proves its own numbering", () => {
    const meta = parseEpisodeMeta("[Sakurato] Frieren [S02E03][1080p].mkv");
    expect(meta.number).toBe(3);
    expect(meta.numberSpace).toBe("perSeason");
  });

  test("★ a bare bracketed number proves nothing", () => {
    // This is the dominant fansub form and the one continuous numbering hides
    // in: [03] of season two and [15] of the whole run look identical.
    expect(parseEpisodeMeta("[VCB] Steins Gate [12][Ma10p_1080p].mkv").numberSpace)
      .toBe("unknown");
  });

  test("★ a season in the name does NOT make the number per-season", () => {
    // 第二季 + 第87話 is routinely a continuously numbered 87. The season
    // token says which season the episode belongs to; it says nothing about
    // where its numbering starts.
    const meta = parseEpisodeMeta("[Group] 進撃の巨人 第二季 [第87話][1080p].mkv");
    expect(meta.season).toBe(2);
    expect(meta.number).toBe(87);
    expect(meta.numberSpace).toBe("unknown");
  });

  test("★ 總第N alongside a different number means ours is the season's", () => {
    const meta = parseEpisodeMeta("[千夏字幕組][哆啦A夢][總第67][第03話][1080P].mkv");
    expect(meta.number).toBe(3);
    expect(meta.episodeAlt).toBe(67);
    expect(meta.numberSpace).toBe("perSeason");
  });

  test("★ 總第N as the only number means we read the franchise's own count", () => {
    const meta = parseEpisodeMeta("[Sakura][Doraemon][總第67][BIG5][1080P].mp4");
    expect(meta.number).toBe(67);
    expect(meta.episodeAlt).toBe(67);
    expect(meta.numberSpace).toBe("absolute");
  });

  test("a continuously numbered long-runner is unknown, not absolute", () => {
    // 1091 IS absolute in fact — but the filename never says so, and a guess
    // that happens to be right is still a guess. The whole reason this field
    // exists is that the last inference of this shape put 21,001 episode-title
    // rows past their own season's episode count.
    const meta = parseEpisodeMeta("[Lilith-Raws] One Piece - 1091 [1080p].mkv");
    expect(meta.number).toBe(1091);
    expect(meta.numberSpace).toBe("unknown");
  });

  test("no number at all is unknown", () => {
    const meta = parseEpisodeMeta("[Group] Show [Menu][1080p].mkv");
    expect(meta.number).toBeNull();
    expect(meta.numberSpace).toBe("unknown");
  });

  test("an empty filename answers unknown rather than throwing", () => {
    expect(parseEpisodeMeta("").numberSpace).toBe("unknown");
    expect(parseEpisodeMeta(null).numberSpace).toBe("unknown");
  });

  test("every meta carries the field, so absent can never be mistaken for a verdict", () => {
    for (const name of [
      "[Group] Show [03][1080p].mkv",
      "[Group] Show [S01E03][1080p].mkv",
      "[Group] Show [Menu].mkv",
      "Show - 12 .mkv",
    ]) {
      expect(parseEpisodeMeta(name)).toHaveProperty("numberSpace");
    }
  });
});

describe("the two signals numberSpace is derived from", () => {
  test("parseSeason reads the season, in priority order", () => {
    expect(parseSeason("[Group] Show [S02E03].mkv")).toBe(2);
    expect(parseSeason("[Group] Show Season 4 [03].mkv")).toBe(4);
    expect(parseSeason("[Group] Show 3rd Season [03].mkv")).toBe(3);
    expect(parseSeason("[Group] Show S2 [03].mkv")).toBe(2);
    expect(parseSeason("[Group] 某番 第4季 [03].mkv")).toBe(4);
    expect(parseSeason("[Group] 某番 第四季 [03].mkv")).toBe(4);
    expect(parseSeason("[Group][Show II][03].mkv")).toBe(2);
    expect(parseSeason("[Group] Show [03].mkv")).toBeNull();
  });

  test("★ a Roman numeral only counts in a season-tail position", () => {
    // The rule is deliberately narrow so a numeral inside a title — the
    // comment names "FF VII Remake" — is not read as a season. Mid-name is
    // therefore null, and that is the answer, not a miss.
    expect(parseSeason("[Group] Show II [03].mkv")).toBeNull();
    expect(parseSeason("[Group] Final Fantasy VII Remake [03].mkv")).toBeNull();
    expect(parseSeason("[Group] Show III - 03 .mkv")).toBe(3);
  });

  test("parseAbsoluteEpisode reads 總第N and 总第N, and nothing else", () => {
    expect(parseAbsoluteEpisode("[Group][總第67][03].mkv")).toBe(67);
    expect(parseAbsoluteEpisode("[Group][总第 67][03].mkv")).toBe(67);
    // Its own doc is explicit that a null means "the name has no such marker",
    // never "this file has no absolute number".
    expect(parseAbsoluteEpisode("[Group] Show [67].mkv")).toBeNull();
  });
});

describe("parseAnimeKeyword — the title ends where the season-episode token starts", () => {
  // The title is what the library searches by when the file hash is unknown,
  // and what an unmatched card is called. `- S01` or a release year left on
  // it finds nothing: dandanplay answers "Nama-Anaru" with the right show and
  // "Nama-Anaru - S01" with nothing at all.
  test("★ `Title - S01E08` drops the ` - S01`", () => {
    expect(parseAnimeKeyword("[Judas] Nama-Anaru - S01E08.mkv")).toBe("Nama-Anaru");
    expect(parseAnimeKeyword("[Judas] Kusuriya - S03E08.mkv")).toBe("Kusuriya");
  });

  test("`Title S04E09 [..]` with no dash", () => {
    expect(
      parseAnimeKeyword(
        "[Feibanyama] ReZERO Starting Life in Another World S04E09 [IQIYI WebRip 2160p HEVC AAC Multi-Audio Multi-Subs].mkv",
      ),
    ).toBe("ReZERO Starting Life in Another World");
  });

  test("`[Group] - Title - S01E08` (Doomdos) has no leading dash", () => {
    expect(parseAnimeKeyword("[Doomdos] - Mononoke - S01E08 [Dub] [720p OV WEB-DL].mkv")).toBe("Mononoke");
  });

  test("a release year before the SxxEyy token stays: it tells a remake from the original", () => {
    expect(
      parseAnimeKeyword("Super no Ura de Yani Suu Futari 2026 S01E11-[1080p][WEBRIP][AV1.AAC].mkv"),
    ).toBe("Super no Ura de Yani Suu Futari 2026");
    expect(parseAnimeKeyword("Hunter x Hunter 2011 S01E05.mkv")).toBe("Hunter x Hunter 2011");
  });

  test("a title starting with a dot keeps it", () => {
    expect(parseAnimeKeyword("[Group] .hack Sign - 03 [1080p].mkv")).toBe(".hack Sign");
  });

  test("an episode title after the SxxEyy token is not part of the title", () => {
    expect(
      parseAnimeKeyword(
        "The Detective Is Already Dead S02E06 Guardian of the World 1080p CR WEB-DL DUAL AAC2.0 H.264-VARYG.mkv",
      ),
    ).toBe("The Detective Is Already Dead");
  });

  test("★ a trailing `S2` before ` - 07` is a season, not title", () => {
    expect(parseAnimeKeyword("[LoliHouse] Ao Ashi S2 - 07 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv")).toBe(
      "Ao Ashi",
    );
    expect(
      parseAnimeKeyword(
        "[LoliHouse] Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e S4 - 04 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
      ),
    ).toBe("Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e");
  });

  test("a folder name ending in a bare season token", () => {
    expect(parseAnimeKeyword("[WEBrip] Super no Ura de Yani Suu Futari S01 [ktnbytes]")).toBe(
      "Super no Ura de Yani Suu Futari",
    );
  });

  test("titles that merely end in a number or a year keep them", () => {
    expect(parseAnimeKeyword("[LoliHouse] Mato Seihei no Slave 2 - 03 [WebRip 1080p].mkv")).toBe(
      "Mato Seihei no Slave 2",
    );
    expect(parseAnimeKeyword("[ANi] Ranma 1/2 2024 - 08 [1080P][Baha][WEB-DL][AAC AVC][CHT].mp4")).toBe(
      "Ranma 1/2 2024",
    );
  });

  test("the season is still read from the SxxEyy token", () => {
    const meta = parseEpisodeMeta("[Judas] Kusuriya - S03E08.mkv");
    expect(meta.title).toBe("Kusuriya");
    expect(meta.season).toBe(3);
    expect(meta.number).toBe(8);
  });
});
