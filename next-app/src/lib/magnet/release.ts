// What a release title says about itself: episode, resolution, subtitle
// language, codec and source.
//
// Release titles are free text written by hundreds of groups, so every rule
// here is a reading of what the real feeds carry (the 629 titles behind the
// redesign — Frieren season 2 and Re:Zero season 4 — plus the patterns the
// old modal matched), not a grammar. Each reader answers "not stated" rather
// than guess: a missing tag costs nothing, a wrong one sends a reader to the
// wrong file.
//
// Pure: no React, no DOM, no clock.

/** One episode, or a release covering many. Null when the title does not say. */
export type ReleaseEpisode = { kind: "single"; n: number } | { kind: "batch" } | null;

/** Which Chinese script the subtitles are in. */
export type SubtitleScript = "simp" | "trad" | "both";

/** Whether subtitles are burned in (内嵌) or carried as a track (内封). */
export type SubtitleEmbed = "hard" | "soft";

export interface ReleaseFacts {
  episode: ReleaseEpisode;
  resolution: "2160P" | "1080P" | "720P" | null;
  script: SubtitleScript | null;
  embed: SubtitleEmbed | null;
  codec: "HEVC" | "AV1" | "AVC" | null;
  source: "WEB" | "BDRip" | null;
}

// ── Episode ──────────────────────────────────────────────────────────

/** Words that name a multi-episode release outright. */
const BATCH_WORD = /batch|合集|全集|全\s*\d{1,3}\s*[话話集]|\bcomplete\b/i;

/**
 * An episode range such as `01-12`, `[1~24]`, `67-77`, `总第67~85`. Both ends
 * are at most three digits and not glued to more digits, which keeps years
 * (`2025-2026`) out; `isRange` then turns away the look-alikes below.
 */
const EPISODE_RANGE = /(?:^|[^\d.])(\d{1,3})\s*[-~～]\s*(\d{1,3})(?![\d.])/g;

/** Calendar dates ("2026-10-04", "2026.10.04") would otherwise read as ranges or episodes. */
const DATE = /\d{4}[-./]\d{1,2}[-./]\d{1,2}/g;

/** A number that ends a season or title marker: "S2", "Season 3", "Part 2", "No. 8". */
const MARKER_BEFORE = /(?:\bS|season\s*|part\s*|no\.\s*)$/i;
/** An opening bracket right before the first number: "[1 - 12]", "(01 ~ 13)". */
const BRACKET_BEFORE = /[[【(（]\s*$/;

/**
 * Whether one of the title's number pairs is an episode range. Turned away:
 *   - a falling pair ("x265-10bit");
 *   - a pair whose first number closes a marker ("S2 - 05", "Season 3 - 05",
 *     "Kaiju No. 8 - 10"): that is the season or title, then the episode;
 *   - " 2 - 03" written with the spaced dash groups put between a title and
 *     its episode, unless the first number is zero-padded ("01 - 12") or
 *     opens a bracket ("[1 - 12]"). Ranges are written "01-12" or "1~12".
 * (No lookbehind: it is a syntax error in Safari before 16.4.)
 */
function isRange(title: string): boolean {
  for (const m of title.matchAll(EPISODE_RANGE)) {
    const [whole, from, to] = m;
    if (Number.parseInt(to, 10) <= Number.parseInt(from, 10)) continue;
    const fromAt = whole.indexOf(from);
    const before = title.slice(0, (m.index ?? 0) + fromAt);
    if (MARKER_BEFORE.test(before)) continue;
    const dash = whole.slice(fromAt + from.length, whole.length - to.length);
    const spaced = /^\s+\S\s+$/.test(dash);
    if (spaced && !/^0\d/.test(from) && !BRACKET_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/** A Blu-ray release; without an episode number it is the whole season. */
const BLU_RAY = /BDRip|BD-?Remux|Blu-?ray|\bBD\b|\bBD\d{3,4}/i;

/**
 * Single-episode spellings, most specific first. Each captures the number in
 * group 1; an optional `v2`-style revision suffix is allowed after it.
 *
 *   S04E19         Re Zero kara Hajimeru Isekai S04E19
 *   - 05 / - 05v2  Show - 05 [1080p]   (a following "(73)" is the cumulative copy)
 *   第05话/話/集    第05话
 *   [05] / 【05】   [Show][05][1080P]
 *   [19 - 总第85]   [Show][19 - 总第85]   (the season's own number comes first)
 *   EP05 / E05     Show EP05
 *   " 05 ["        Show 05 [1080p]
 *
 * `(?!\.\d)` after each number turns away "- 12.5": a recap numbered between
 * two episodes is neither of them, so it reads as unstated.
 */
const SINGLE_EPISODE: readonly RegExp[] = [
  /\bS\d{1,2}E(\d{1,3})(?![\d.])/i,
  /\s-\s(\d{1,3})(?!\.\d)(?:v\d)?(?=$|[\s[(（【.])/,
  /第\s*(\d{1,3})\s*[话話集]/,
  /[[【](\d{1,3})(?!\.\d)(?:v\d)?(?:\s*(?:END|FIN|完))?[\]】]/i,
  /[[【](\d{1,3})\s*-\s*[总總]第\s*\d{1,4}[\]】]/,
  /\bEP?\.?\s?(\d{1,3})(?!\.\d)(?:v\d)?\b/i,
  /\s(\d{2,3})(?!\.\d)(?:v\d)?\s*[[(（【]/,
];

function singleEpisode(title: string): number | null {
  for (const re of SINGLE_EPISODE) {
    const m = re.exec(title);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > 0) return n;
  }
  return null;
}

/**
 * The episode a title names, or that it is a batch.
 *
 * A range or a batch word wins over a single number, because batches carry
 * numbers too (`[01-24(73-96) 合集]`). A Blu-ray title with no episode number
 * is a season box. Anything else with no recognisable number is unstated.
 */
export function parseEpisode(title: string): ReleaseEpisode {
  const text = title.replace(DATE, " ");
  if (BATCH_WORD.test(text) || isRange(text)) return { kind: "batch" };
  const n = singleEpisode(text);
  if (n !== null) return { kind: "single", n };
  if (BLU_RAY.test(text)) return { kind: "batch" };
  return null;
}

// ── Resolution, codec, source ────────────────────────────────────────

export function parseResolution(title: string): ReleaseFacts["resolution"] {
  if (/2160[pP]|\b4K\b|3840\s*[x×]\s*2160/i.test(title)) return "2160P";
  if (/1080[pPiI]|1920\s*[x×]\s*1080/.test(title)) return "1080P";
  if (/720[pP]|1280\s*[x×]\s*720/.test(title)) return "720P";
  return null;
}

export function parseCodec(title: string): ReleaseFacts["codec"] {
  if (/HEVC|[xX]\.?265|H\.?265/i.test(title)) return "HEVC";
  if (/\bAV1\b/i.test(title)) return "AV1";
  if (/\bAVC\b|[xX]\.?264|H\.?264/i.test(title)) return "AVC";
  return null;
}

export function parseSource(title: string): ReleaseFacts["source"] {
  if (BLU_RAY.test(title)) return "BDRip";
  if (/WEB[-\s]?DL|WEB[-\s]?Rip|\bWEB\b|\bCR\b|Baha|B-Global|\bNF\b|AMZN|ViuTV|IQIYI/i.test(title)) {
    return "WEB";
  }
  return null;
}

// ── Subtitles ────────────────────────────────────────────────────────

/** Both scripts named together: 简繁, CHS&CHT, GB&BIG5 and the reverse orders. */
const BOTH_SCRIPTS = /简繁|簡繁|繁简|繁簡|(?:CHS|GB)\s*[&+＆/／_、]\s*(?:CHT|BIG5)|(?:CHT|BIG5)\s*[&+＆/／_、]\s*(?:CHS|GB)/i;

/**
 * Latin tags that name one script, as whole tokens: `[CHS]`, `_GB_`, `BIG5`.
 * GB is also a unit, so a GB written right after a number ("1.2 GB",
 * "700GB") is a size and does not count.
 */
const SIMP_TAG = /(^|[^A-Za-z0-9])(CHS|GB|SC)(?![A-Za-z0-9])/gi;
const TRAD_TAG = /(^|[^A-Za-z0-9])(CHT|BIG5|TC)(?![A-Za-z0-9])/gi;
const SIZE_BEFORE = /\d\s*$/;

function hasTag(title: string, tag: RegExp): boolean {
  for (const m of title.matchAll(tag)) {
    const before = title.slice(0, (m.index ?? 0) + m[1].length);
    if (m[2].toUpperCase() === "GB" && SIZE_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

export function parseScript(title: string): SubtitleScript | null {
  if (BOTH_SCRIPTS.test(title)) return "both";
  const simp = /简|簡体|簡體/.test(title) || hasTag(title, SIMP_TAG);
  const trad = /繁/.test(title) || hasTag(title, TRAD_TAG);
  if (simp && trad) return "both";
  if (simp) return "simp";
  if (trad) return "trad";
  return null;
}

export function parseEmbed(title: string): SubtitleEmbed | null {
  if (/内封|內封/.test(title)) return "soft";
  if (/内嵌|內嵌/.test(title)) return "hard";
  return null;
}

export function parseRelease(title: string): ReleaseFacts {
  return {
    episode: parseEpisode(title),
    resolution: parseResolution(title),
    script: parseScript(title),
    embed: parseEmbed(title),
    codec: parseCodec(title),
    source: parseSource(title),
  };
}

// ── Group name and title ─────────────────────────────────────────────

/** Zero-width characters some feeds leave in group names ("7³ACG​"). */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/** The group name as it should be shown and grouped on: zero-width marks removed, trimmed. */
export function cleanFansub(fansub: string | null | undefined): string {
  return (fansub ?? "").replace(ZERO_WIDTH, "").trim();
}

const LEADING_BRACKET = /^\s*[[【]([^\]】]{1,60})[\]】]\s*/;

/**
 * The title without its leading `[Group]`, when that bracket is exactly the
 * group shown on the line above it. Anything else in the bracket — a second
 * group, a date, a tag — stays, because it is information the group line
 * does not carry.
 */
export function titleWithoutGroup(title: string, fansub: string): string {
  if (!fansub) return title;
  const m = LEADING_BRACKET.exec(title);
  if (!m || cleanFansub(m[1]) !== fansub) return title;
  const rest = title.slice(m[0].length).trim();
  return rest || title;
}
