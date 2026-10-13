import { describe, expect, test } from "bun:test";

import { dirOf, matchSidecars, sidecarDescriptor, type SidecarCandidate } from "./sidecars";

function sub(fileName: string, episode: number | null, dir: string | null = null): SidecarCandidate {
  return { fileName, episode, dir, type: fileName.split(".").pop() ?? "" };
}

const names = (xs: SidecarCandidate[]) => xs.map((x) => x.fileName);

describe("matchSidecars", () => {
  test("every file named after the video, not just the first", () => {
    const subs = [
      sub("Demo - 02.tc.ass", 2),
      sub("Demo - 02.sc.ass", 2),
      sub("Demo - 02.srt", 2),
      sub("Demo - 03.sc.ass", 3),
    ];
    expect(names(matchSidecars({ fileName: "Demo - 02.mkv", episode: 2 }, subs))).toEqual([
      "Demo - 02.sc.ass",
      "Demo - 02.tc.ass",
      "Demo - 02.srt",
    ]);
  });

  test("a longer name is not a match: 02v2 and 020 are other files", () => {
    const subs = [sub("Demo - 02v2.ass", 2), sub("Demo - 020.ass", 20), sub("Demo - 02 [CHS].ass", 2)];
    expect(names(matchSidecars({ fileName: "Demo - 02.mkv", episode: null }, subs))).toEqual(["Demo - 02 [CHS].ass"]);
  });

  test("no file named after the video: fall back to the episode number", () => {
    const subs = [sub("[Group] Show [02][CHS].ass", 2), sub("[Group] Show [03][CHS].ass", 3)];
    expect(names(matchSidecars({ fileName: "[Other] Show - 02 [1080p].mkv", episode: 2 }, subs))).toEqual([
      "[Group] Show [02][CHS].ass",
    ]);
  });

  test("files in a subfolder of the video's folder count", () => {
    const subs = [sub("Show - 03.chs.ass", 3, "Show S1/Subs"), sub("Show - 03.cht.ass", 3, "Show S1/Subs/old")];
    expect(names(matchSidecars({ fileName: "Show - 03.mkv", episode: 3, dir: "Show S1" }, subs))).toEqual([
      "Show - 03.chs.ass",
    ]);
  });

  test("the episode fallback stays near the video's folder", () => {
    const subs = [sub("S2 - 03.ass", 3, "Show S2"), sub("x 03.ass", 3, "Show S1")];
    expect(names(matchSidecars({ fileName: "Show - 03.mkv", episode: 3, dir: "Show S1" }, subs))).toEqual(["x 03.ass"]);
  });

  test("nothing matches: nothing attached", () => {
    expect(matchSidecars({ fileName: "Movie.mkv", episode: null }, [sub("Other.ass", null)])).toEqual([]);
  });
});

describe("sidecarDescriptor", () => {
  test("the part after the video's name", () => {
    expect(sidecarDescriptor("Demo - 02.mkv", "Demo - 02.sc.ass")).toBe("sc");
    expect(sidecarDescriptor("Demo - 02.mkv", "Demo - 02 [简体].ass")).toBe("[简体]");
    expect(sidecarDescriptor("Demo - 02.mkv", "Demo - 02.ass")).toBe("");
  });

  test("the whole stem when the names are unrelated", () => {
    expect(sidecarDescriptor("A - 02.mkv", "[Group] A [02][CHT].ass")).toBe("[Group] A [02][CHT]");
  });
});

describe("dirOf", () => {
  test("folder part of a relative path", () => {
    expect(dirOf("Show/S1/ep.mkv")).toBe("Show/S1");
    expect(dirOf("ep.mkv")).toBe("");
  });
});
