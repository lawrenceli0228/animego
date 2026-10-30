import { describe, expect, test } from "bun:test";
import {
  cleanFansub,
  parseCodec,
  parseEmbed,
  parseEpisode,
  parseRelease,
  parseResolution,
  parseScript,
  parseSource,
  titleWithoutGroup,
} from "./release";

// Titles are copied from the live feeds for Frieren season 2 (182255) and
// Re:Zero season 4 (189046) — the two lists the redesign was drawn from.

describe("parseEpisode — one episode", () => {
  test.each([
    ["[jibaketa合成][代理商粵語]葬送的芙莉蓮 第二季 / Sousou no Frieren 2nd Season - 10 END [粵日雙語+內封繁體中文字幕] (WEB 1920x1080 AVC AACx2 SRT MUSE CHT)", 10],
    ["[Skymoon-Raws] Re：從零開始的異世界生活 第四季 / Re：Zero kara Hajimeru Isekai Seikatsu 4th Season - 19 [ViuTV][WEB-DL][CHT][1080p][AVC AAC]", 19],
    ["【TSDM字幕组】[Re:从零开始的异世界生活 第4季][16][HEVC-10bit 1080p AAC][MKV][简日内封字幕][Re Zero kara Hajimeru Isekai Seikatsu 4th Season]", 16],
    ["[Nix-Raws] Re：从零开始的异世界生活 第四季 / Re Zero kara Hajimeru Isekai S04E19 [CR WEB-DL 1080p AVC AAC][简繁内封]", 19],
    ["[綠茶字幕組] 葬送的芙莉蓮 第二季 / Sousou no Frieren S2 [38][WebRip][1080p][繁日內嵌]", 38],
    ["[晚街与灯][Re：从零开始的异世界生活 第四季 / Re:Zero kara Hajimeru Isekai Seikatsu 4th Season][19 - 总第85][WebRip][1080P_AVC_AAC][简日双语内嵌]", 19],
    ["[Group] Show 第05话 [1080p]", 5],
    ["[Group] Show - 05v2 [1080p]", 5],
    ["[Group] Show EP07 [1080p]", 7],
    ["[Group] Show 08 [1080p]", 8],
    ["[GM-Team][国漫][一念永恒 第4季][Yi Nian Yong Heng 4th Season][2026][16][AVC][GB][1080P]", 16],
  ])("%s → %d", (title, n) => {
    expect(parseEpisode(title)).toEqual({ kind: "single", n });
  });

  test("the season's own number wins over the cumulative copy beside it", () => {
    const title =
      "[豌豆字幕组&LoliHouse] 关于我转生变成史莱姆这档事 第四季 / Tensei Shitara Slime Datta Ken 4th Season - 24(96) [WebRip 1080p HEVC-10bit AAC][简繁外挂字幕][END]";
    expect(parseEpisode(title)).toEqual({ kind: "single", n: 24 });
  });

  test("a year, a resolution or a date is not an episode", () => {
    expect(parseEpisode("[Group] Show [2026][1080P]")).toBeNull();
    expect(parseEpisode("[JMAX] [2026.10.04] TVアニメ「おそ松さん 4th Season」EDテーマ [FLAC]")).toBeNull();
  });

  test("a recap numbered between two episodes is neither", () => {
    expect(parseEpisode("[Group] Show - 12.5 [1080p]")).toBeNull();
  });
});

describe("parseEpisode — batches", () => {
  test.each([
    "[Erai-raws] Sousou no Frieren 2nd Season [1080p CR WEBRip HEVC AAC][MultiSub] (unofficial batch)",
    "[云光字幕组]葬送的芙莉莲 第二季 Sousou no Frieren S2 [合集][简体双语][1080p]招募翻译",
    "[千夏字幕组][葬送的芙莉莲_Sousou no Frieren][第29-38话][1080p_AVC][繁体][合集]",
    "[晚街与灯][Re：从零开始的异世界生活 第四季合集 全（丧失篇+夺回篇+小剧场） / Re:Zero kara Hajimeru Isekai Seikatsu 4th][总第67~85][WebRip][1080P_AVC_AAC][简日双语内嵌]",
    "[芝士动物朋友] Re：从零开始的异世界生活 第四季 丧失篇 / Re:Zero kara Hajimeru Isekai Seikatsu 4th Season [67-77][CR-WebRip 1080p HEVC AAC]",
    "【MMSUB】[东离剑游纪 第4季 / Thunderbolt Fantasy 4th Season][01-12 Fin][WebRip 1080p HEVC-10bit AAC][简繁内封字幕]",
    "[豌豆字幕组&LoliHouse] 关于我转生变成史莱姆这档事 第四季 / Tensei Shitara Slime Datta Ken 4th Season [01-24(73-96) 合集][WebRip 1080p HEVC-10bit AAC][简繁外挂字幕][Fin]",
  ])("%s", (title) => {
    expect(parseEpisode(title)).toEqual({ kind: "batch" });
  });

  test("a Blu-ray title with no episode number is the season box", () => {
    expect(parseEpisode("[7³ACG] Sousou no Frieren 葬送のフリーレン 2nd Season [BDRip 1080p x265 OPUS]")).toEqual({ kind: "batch" });
    expect(parseEpisode("[kikuri] Sousou no Frieren 2nd Season (BD 1080p HEVC Opus) | Frieren: Beyond Journey's End S02")).toEqual({ kind: "batch" });
  });

  test("a season or title number before the spaced dash is not a range", () => {
    expect(parseEpisode("[SubsPlease] Spy x Family S2 - 05 (1080p) [ABCD1234].mkv")).toEqual({ kind: "single", n: 5 });
    expect(parseEpisode("Sousou no Frieren S2 - 05")).toEqual({ kind: "single", n: 5 });
    expect(parseEpisode("[Group] Oshi no Ko Season 3 - 05 [1080p]")).toEqual({ kind: "single", n: 5 });
    expect(parseEpisode("[Group] Show Part 2 - 07 [1080p]")).toEqual({ kind: "single", n: 7 });
    expect(parseEpisode("[Group] Re Zero kara Hajimeru Isekai Seikatsu S4 - 19 (85) [1080p]")).toEqual({ kind: "single", n: 19 });
    expect(parseEpisode("[Group] Show 2 - 03 [1080p]")).toEqual({ kind: "single", n: 3 });
    expect(parseEpisode("[Group] Kaiju No. 8 - 10 [1080p]")).toEqual({ kind: "single", n: 10 });
  });

  test("ranges written with a padded start, inside a bracket, or without spaces stay ranges", () => {
    expect(parseEpisode("[Group] Show [01 - 12][1080p]")).toEqual({ kind: "batch" });
    expect(parseEpisode("[Group] Show [1 - 12][1080p]")).toEqual({ kind: "batch" });
    expect(parseEpisode("[Group] Show S2 [1-12][1080p]")).toEqual({ kind: "batch" });
    expect(parseEpisode("[Group] Show 01~13 [1080p]")).toEqual({ kind: "batch" });
  });

  test("x265-10bit is not a range", () => {
    expect(parseEpisode("[Group] Show - 03 [1080p x265-10bit]")).toEqual({ kind: "single", n: 3 });
  });

  test("a title that states neither shows no tag", () => {
    expect(parseEpisode("[Shiniori-Raws]葬送的芙莉莲 第二季/Sousou no Frieren S2 4k 2160p x265 10bit")).toBeNull();
  });
});

describe("parseScript / parseEmbed", () => {
  test.each([
    ["[Group] Show - 01 [简繁内封]", "both"],
    ["[Group] Show - 01 [簡繁內封]", "both"],
    ["[Group] Show - 01 [CHS&CHT]", "both"],
    ["[Group] Show - 01 [GB&BIG5]", "both"],
    ["[晚街与灯][Show][WEB-DL Remux][简繁日内封PGS]", "both"],
    ["[Group] Show - 01 [简日双语内嵌]", "simp"],
    ["[桜都字幕组][我的英雄学院 第四季][08][GB][1080P]", "simp"],
    ["[Group] Show - 01 [CHS]", "simp"],
    ["[Group] Show - 01 [繁日雙語內嵌]", "trad"],
    ["[Skymoon-Raws] Show - 19 [ViuTV][WEB-DL][CHT][1080p]", "trad"],
    ["[Group] Show - 01 [BIG5][MP4]", "trad"],
  ])("%s → %s", (title, script) => {
    expect(parseScript(title)).toBe(script as "simp" | "trad" | "both");
  });

  test("GB right after a number is a size, not a script", () => {
    expect(parseScript("[Group] Show - 01 [1080p] 1.2 GB")).toBeNull();
    expect(parseScript("[Group] Show - 01 [1080p][700GB]")).toBeNull();
  });

  test("no script named → null", () => {
    expect(parseScript("[Erai-raws] Sousou no Frieren 2nd Season - 10 [1080p CR WEB-DL AVC AAC][MultiSub]")).toBeNull();
  });

  test("embed: 内封 is a track, 内嵌 is burned in, either script", () => {
    expect(parseEmbed("[简繁内封字幕]")).toBe("soft");
    expect(parseEmbed("[簡繁內封]")).toBe("soft");
    expect(parseEmbed("[简日内嵌]")).toBe("hard");
    expect(parseEmbed("[繁日內嵌]")).toBe("hard");
    expect(parseEmbed("[简繁外挂字幕]")).toBeNull();
  });
});

describe("resolution / codec / source", () => {
  test("resolution", () => {
    expect(parseResolution("Show S2 4k 2160p x265")).toBe("2160P");
    expect(parseResolution("(WEB 1920x1080 AVC AAC)")).toBe("1080P");
    expect(parseResolution("[1080P]")).toBe("1080P");
    expect(parseResolution("[720p CR WEB-DL]")).toBe("720P");
    expect(parseResolution("[480p CR WEB-DL]")).toBeNull();
  });
  test("codec", () => {
    expect(parseCodec("[BDRip 1080p x265 OPUS]")).toBe("HEVC");
    expect(parseCodec("[HEVC-10bit]")).toBe("HEVC");
    expect(parseCodec("[BDRip 1080p AV1 OPUS]")).toBe("AV1");
    expect(parseCodec("(CR 1920x1080 AVC AAC MKV)")).toBe("AVC");
    expect(parseCodec("[x264]")).toBe("AVC");
    expect(parseCodec("[1080p]")).toBeNull();
  });
  test("source", () => {
    expect(parseSource("[BDRip 1080p HEVC]")).toBe("BDRip");
    expect(parseSource("(BD 1920x1080 x265)")).toBe("BDRip");
    expect(parseSource("[WebRip 1080p]")).toBe("WEB");
    expect(parseSource("[CR WEB-DL 1080p]")).toBe("WEB");
    expect(parseSource("(Baha 1920x1080 AVC AAC MP4)")).toBe("WEB");
    expect(parseSource("[1080P][GB]")).toBeNull();
  });
  test("parseRelease gathers all of them", () => {
    expect(parseRelease("[Nix-Raws] Re：从零开始的异世界生活 第四季 / Re Zero kara Hajimeru Isekai S04E19 [CR WEB-DL 1080p AVC AAC][简繁内封]")).toEqual({
      episode: { kind: "single", n: 19 },
      resolution: "1080P",
      script: "both",
      embed: "soft",
      codec: "AVC",
      source: "WEB",
    });
  });
});

describe("cleanFansub / titleWithoutGroup", () => {
  test("zero-width marks and padding are removed", () => {
    expect(cleanFansub("7³ACG​")).toBe("7³ACG");
    expect(cleanFansub("  NC-Raws ")).toBe("NC-Raws");
    expect(cleanFansub(null)).toBe("");
  });

  test("the leading bracket goes when it is exactly the group", () => {
    expect(titleWithoutGroup("[NC-Raws] 文豪野犬 - 41 (CR 1920x1080)", "NC-Raws")).toBe("文豪野犬 - 41 (CR 1920x1080)");
    expect(titleWithoutGroup("【TSDM字幕组】[Re:从零开始的异世界生活 第4季][16]", "TSDM字幕组")).toBe("[Re:从零开始的异世界生活 第4季][16]");
    expect(titleWithoutGroup("[7³ACG​] Sousou no Frieren", "7³ACG")).toBe("Sousou no Frieren");
  });

  test("a bracket naming someone else stays — it is information the group line lacks", () => {
    expect(titleWithoutGroup("[黒ネズミたち] 葬送的芙莉蓮 第二季 - 05", "Kirara Fantasia")).toBe("[黒ネズミたち] 葬送的芙莉蓮 第二季 - 05");
    expect(titleWithoutGroup("[爱恋&漫猫字幕社][1月新番][葬送的芙莉蓮 第二季]", "爱恋字幕社")).toBe("[爱恋&漫猫字幕社][1月新番][葬送的芙莉蓮 第二季]");
  });

  test("no group, or nothing after the bracket → the title as given", () => {
    expect(titleWithoutGroup("[NC-Raws] Show", "")).toBe("[NC-Raws] Show");
    expect(titleWithoutGroup("[NC-Raws]", "NC-Raws")).toBe("[NC-Raws]");
  });
});
