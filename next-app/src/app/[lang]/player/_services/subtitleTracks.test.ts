import { describe, expect, test } from "bun:test";

import type { MkvTrackInfo } from "@/lib/subtitles/matroska";
import type { MkvWorkerTrack } from "@/lib/subtitles/workerProtocol";
import {
  activeTrack,
  convertSidecarSubtitle,
  initialSubtitleTracksState,
  readSubtitleFile,
  sidecarTrack,
  subtitleTracksReducer as reduce,
  type SubtitleTracksAction,
  type SubtitleTracksState,
} from "./subtitleTracks";

const SRT = ["1", "00:00:01,000 --> 00:00:03,000", "{\\an8}顶部字幕", ""].join("\n");

const ASS = [
  "[Script Info]",
  "Title: fixture",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}顶部字幕",
].join("\n");

describe("convertSidecarSubtitle", () => {
  test("srt becomes VTT and loses its override tags", () => {
    const { vtt, assContent } = convertSidecarSubtitle(SRT, "srt");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).toContain("顶部字幕");
    expect(assContent).toBeNull();
  });

  test("★ ass yields BOTH a stripped VTT and the untouched original", () => {
    // The VTT is the fallback layer artplayer renders and must be plain text.
    // `assContent` is what jassub gets and must keep its override tags.
    const { vtt, assContent } = convertSidecarSubtitle(ASS, "ass");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).not.toContain("{\\an8}");
    expect(assContent).toBe(ASS);
  });

  test("ssa is treated as ass; case does not matter", () => {
    expect(convertSidecarSubtitle(ASS, "ssa").assContent).toBe(ASS);
    expect(convertSidecarSubtitle(SRT, "SRT").vtt.startsWith("WEBVTT")).toBe(true);
  });

  test("an unrecognised format passes through untouched", () => {
    expect(convertSidecarSubtitle("whatever", "xyz")).toEqual({ vtt: "whatever", assContent: null });
  });
});

describe("readSubtitleFile", () => {
  test("reads and converts", async () => {
    const out = await readSubtitleFile(new File([SRT], "ep01.srt"), "srt");
    expect(out?.vtt).toContain("顶部字幕");
  });

  test("an unreadable file resolves null instead of rejecting", async () => {
    const broken = { name: "ep01.srt", text: () => Promise.reject(new Error("disk gone")) } as unknown as File;
    expect(await readSubtitleFile(broken, "srt")).toBeNull();
  });
});

// ─── State ─────────────────────────────────────────────────────────────────

function info(number: number, over: Partial<MkvTrackInfo> = {}): MkvTrackInfo {
  return {
    number,
    codecId: "S_TEXT/ASS",
    format: "ass",
    supported: true,
    name: "",
    language: "chi",
    languageBcp47: null,
    isDefault: false,
    isForced: false,
    ...over,
  };
}

function content(i: MkvTrackInfo, vtt = `WEBVTT\n\n${i.number}`): MkvWorkerTrack {
  return { ...i, assContent: i.format === "ass" ? `[Script Info]\n${i.number}` : null, vtt, cueCount: 1 };
}

const CHS = info(2, { name: "简体中文" });
const CHT = info(3, { name: "繁體中文", isDefault: true });
const ENG = info(4, { name: "English", codecId: "S_TEXT/UTF8", format: "srt", language: "eng" });
const PGS = info(5, { codecId: "S_HDMV/PGS", format: "image", supported: false, isDefault: true });

function run(...actions: SubtitleTracksAction[]): SubtitleTracksState {
  return actions.reduce(reduce, initialSubtitleTracksState);
}

const start = (over: Partial<Extract<SubtitleTracksAction, { type: "start" }>> = {}): SubtitleTracksAction => ({
  type: "start",
  key: "ep1",
  scanEmbedded: true,
  sidecars: [],
  pref: null,
  uiLang: "zh",
  ...over,
});

describe("subtitle tracks: an MKV with several tracks", () => {
  test("no choice is made until the track list is known", () => {
    const s = run(start());
    expect(s.decided).toBe(false);
    expect(s.activeId).toBeNull();
    expect(s.scan.state).toBe("scanning");
  });

  test("the track list arrives: every track listed, the site language chosen", () => {
    const s = run(start(), { type: "embeddedTracks", key: "ep1", tracks: [CHS, CHT, ENG, PGS] });
    expect(s.tracks.map((t) => [t.id, t.lang, t.status])).toEqual([
      ["mkv:2", "zh-Hans", "loading"],
      ["mkv:3", "zh-Hant", "loading"],
      ["mkv:4", "en", "loading"],
      ["mkv:5", "zh", "unsupported"],
    ]);
    expect(s.activeId).toBe("mkv:2");
  });

  test("partial then final content fills the chosen track in place", () => {
    const partial = run(
      start(),
      { type: "embeddedTracks", key: "ep1", tracks: [CHS, CHT] },
      { type: "embeddedContent", key: "ep1", tracks: [content(CHS, "WEBVTT\n\nfirst minutes"), content(CHT)], final: false },
    );
    expect(activeTrack(partial)?.status).toBe("partial");
    expect(activeTrack(partial)?.vtt).toBe("WEBVTT\n\nfirst minutes");
    const done = reduce(partial, { type: "embeddedContent", key: "ep1", tracks: [content(CHS, "WEBVTT\n\nall"), content(CHT)], final: true });
    expect(activeTrack(done)?.status).toBe("ready");
    expect(activeTrack(done)?.vtt).toBe("WEBVTT\n\nall");
    expect(done.scan).toEqual({ state: "done", fraction: 1 });
    expect(done.activeId).toBe("mkv:2");
  });

  test("the reader's saved language wins; 'off' shows nothing", () => {
    expect(run(start({ pref: "zh-Hant" }), { type: "embeddedTracks", key: "ep1", tracks: [CHS, CHT] }).activeId).toBe("mkv:3");
    const off = run(start({ pref: "off" }), { type: "embeddedTracks", key: "ep1", tracks: [CHS, CHT] });
    expect(off.activeId).toBeNull();
    expect(off.decided).toBe(true);
  });

  test("a reader's pick is never overwritten by a later scan result", () => {
    const s = run(
      start(),
      { type: "embeddedTracks", key: "ep1", tracks: [CHS, CHT, ENG] },
      { type: "select", id: "mkv:4" },
      { type: "embeddedContent", key: "ep1", tracks: [content(CHS), content(CHT), content(ENG)], final: true },
    );
    expect(s.activeId).toBe("mkv:4");
    expect(s.choice).toBe("user");
  });

  test("turning subtitles off is a pick too", () => {
    const s = run(start(), { type: "embeddedTracks", key: "ep1", tracks: [CHS] }, { type: "select", id: null });
    expect(s.activeId).toBeNull();
    expect(s.choice).toBe("user");
  });

  test("an image track cannot be selected", () => {
    const s = run(start(), { type: "embeddedTracks", key: "ep1", tracks: [CHS, PGS] }, { type: "select", id: "mkv:5" });
    expect(s.activeId).toBe("mkv:2");
  });

  test("results for an earlier episode are ignored", () => {
    const s = run(
      start({ key: "ep1" }),
      start({ key: "ep2" }),
      { type: "embeddedTracks", key: "ep1", tracks: [CHS] },
      { type: "embeddedContent", key: "ep1", tracks: [content(CHS)], final: true },
    );
    expect(s.key).toBe("ep2");
    expect(s.tracks).toEqual([]);
  });

  test("a result with no prior track list still lists its tracks", () => {
    const s = run(start(), { type: "embeddedContent", key: "ep1", tracks: [content(CHS), content(CHT)], final: true });
    expect(s.tracks.map((t) => [t.id, t.status])).toEqual([
      ["mkv:2", "ready"],
      ["mkv:3", "ready"],
    ]);
    expect(s.activeId).toBe("mkv:2");
  });
});

describe("subtitle tracks: sidecars", () => {
  const sc = { id: "side:Demo - 02.sc.ass", name: "sc", fileName: "Demo - 02.sc.ass", format: "ass" };
  const tc = { id: "side:Demo - 02.tc.ass", name: "tc", fileName: "Demo - 02.tc.ass", format: "ass" };

  test("a non-MKV waits for its sidecars, then picks by language", () => {
    const s0 = run(start({ scanEmbedded: false, sidecars: [tc, sc] }));
    expect(s0.decided).toBe(false);
    const s1 = reduce(s0, { type: "sidecarLoaded", key: "ep1", id: tc.id, vtt: "WEBVTT", assContent: "tc" });
    expect(s1.decided).toBe(false);
    const s2 = reduce(s1, { type: "sidecarLoaded", key: "ep1", id: sc.id, vtt: "WEBVTT", assContent: "sc" });
    expect(s2.activeId).toBe(sc.id);
  });

  test("a sidecar that cannot be read does not hold the choice up", () => {
    const s = run(
      start({ scanEmbedded: false, sidecars: [sc, tc] }),
      { type: "sidecarFailed", key: "ep1", id: sc.id },
      { type: "sidecarLoaded", key: "ep1", id: tc.id, vtt: "WEBVTT", assContent: null },
    );
    expect(s.activeId).toBe(tc.id);
  });

  test("an MKV with sidecars lists both; at equal language the sidecar wins", () => {
    const s = run(
      start({ sidecars: [sc] }),
      { type: "sidecarLoaded", key: "ep1", id: sc.id, vtt: "WEBVTT", assContent: "x" },
      { type: "embeddedTracks", key: "ep1", tracks: [CHS, CHT] },
    );
    expect(s.tracks.map((t) => t.id)).toEqual(["mkv:2", "mkv:3", sc.id]);
    expect(s.activeId).toBe(sc.id);
  });

  test("if the chosen embedded track fails, the next best takes over", () => {
    const s = run(
      start({ sidecars: [tc], pref: "zh-Hans" }),
      { type: "sidecarLoaded", key: "ep1", id: tc.id, vtt: "WEBVTT", assContent: null },
      { type: "embeddedTracks", key: "ep1", tracks: [CHS] },
      { type: "embeddedFailed", key: "ep1", notMatroska: false },
    );
    expect(s.tracks.find((t) => t.id === "mkv:2")?.status).toBe("error");
    expect(s.activeId).toBe(tc.id);
    expect(s.scan.state).toBe("error");
  });

  test("a file that is not really Matroska drops the embedded section quietly", () => {
    const s = run(start({ sidecars: [sc] }), { type: "sidecarLoaded", key: "ep1", id: sc.id, vtt: "WEBVTT", assContent: null }, {
      type: "embeddedFailed",
      key: "ep1",
      notMatroska: true,
    });
    expect(s.tracks.map((t) => t.id)).toEqual([sc.id]);
    expect(s.activeId).toBe(sc.id);
    expect(s.scan.state).toBe("done");
  });

  test("a .sup sidecar is listed as unsupported and never waited for", () => {
    const sup = { id: "side:x.sup", name: "", fileName: "x.sup", format: "sup" };
    const s = run(start({ scanEmbedded: false, sidecars: [sup] }));
    expect(s.tracks[0].status).toBe("unsupported");
    expect(s.decided).toBe(true);
    expect(s.activeId).toBeNull();
  });
});

describe("subtitle tracks: a file the reader loads", () => {
  test("is added, selected, and counts as the reader's choice", () => {
    const user = { ...sidecarTrack({ id: "user:1", name: "mine", fileName: "mine.srt", format: "srt" }, "user"), status: "ready" as const, vtt: "WEBVTT" };
    const s = run(start(), { type: "embeddedTracks", key: "ep1", tracks: [CHS] }, { type: "userTrack", key: "ep1", track: user });
    expect(s.activeId).toBe("user:1");
    expect(s.choice).toBe("user");
    expect(s.tracks.map((t) => t.source)).toEqual(["embedded", "user"]);
  });

  test("a file that could not be read is listed but does not replace what is showing", () => {
    const bad = { ...sidecarTrack({ id: "user:2", name: "bad", fileName: "bad.srt", format: "srt" }, "user"), status: "error" as const };
    const s = run(start(), { type: "embeddedTracks", key: "ep1", tracks: [CHS] }, { type: "userTrack", key: "ep1", track: bad });
    expect(s.activeId).toBe("mkv:2");
    expect(s.tracks.at(-1)?.status).toBe("error");
  });
});
