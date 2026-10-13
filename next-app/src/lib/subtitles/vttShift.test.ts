import { describe, expect, test } from "bun:test";

import { shiftVtt } from "./vttShift";

const VTT = [
  "WEBVTT",
  "",
  "00:00:00.500 --> 00:00:02.000",
  "first",
  "",
  "note-id",
  "00:01:00.000 --> 00:01:02.250 line:10%",
  "second",
  "",
].join("\n");

describe("shiftVtt", () => {
  test("zero is the identity", () => {
    expect(shiftVtt(VTT, 0)).toBe(VTT);
  });

  test("a delay moves every cue later, keeping ids and cue settings", () => {
    const out = shiftVtt(VTT, 1.5);
    expect(out).toContain("00:00:02.000 --> 00:00:03.500\nfirst");
    expect(out).toContain("note-id\n00:01:01.500 --> 00:01:03.750 line:10%\nsecond");
    expect(out.startsWith("WEBVTT")).toBe(true);
  });

  test("an advance drops cues that end before 0 and clamps one that straddles it", () => {
    const out = shiftVtt(VTT, -1);
    expect(out).toContain("00:00:00.000 --> 00:00:01.000\nfirst");
    const gone = shiftVtt(VTT, -3);
    expect(gone).not.toContain("first");
    expect(gone).toContain("00:00:57.000 --> 00:00:59.250 line:10%");
  });

  test("hours, short forms and CRLF are understood", () => {
    const out = shiftVtt("WEBVTT\r\n\r\n01:00.000 --> 1:02:03.400\r\nx\r\n", 10);
    expect(out).toContain("00:01:10.000 --> 01:02:13.400\nx");
  });

  test("past ten seconds — artplayer's own offset stops at ±10 s", () => {
    expect(shiftVtt(VTT, 90)).toContain("00:01:30.500 --> 00:01:32.000");
  });
});
