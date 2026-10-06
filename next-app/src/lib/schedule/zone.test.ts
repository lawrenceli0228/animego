import { describe, expect, test } from "bun:test";
import { SITE_TZ } from "@/lib/home/time";
import { SITE_UTC_OFFSET_MIN, runtimeOffsetMinutes, utcOffsetLabel, zoneNote } from "./zone";

// The schedule's subtitle says which clock its times are on. The server
// renders Shanghai time; after hydration the times move to the browser's
// zone, and the note has to move with them or it is a lie.

describe("utcOffsetLabel", () => {
  test("whole hours, either side of UTC, with a real minus sign", () => {
    expect(utcOffsetLabel(480)).toBe("UTC+8");
    expect(utcOffsetLabel(-420)).toBe("UTC−7");
  });

  test("half and quarter hours keep their minutes", () => {
    expect(utcOffsetLabel(330)).toBe("UTC+5:30");
    expect(utcOffsetLabel(345)).toBe("UTC+5:45");
    expect(utcOffsetLabel(-210)).toBe("UTC−3:30");
  });

  test("UTC itself has no sign", () => {
    expect(utcOffsetLabel(0)).toBe("UTC");
  });
});

describe("runtimeOffsetMinutes", () => {
  test("is getTimezoneOffset with the sign the rest of this module uses (east positive)", () => {
    const ms = Date.UTC(2026, 9, 6, 12, 0);
    expect(runtimeOffsetMinutes(ms)).toBe(-new Date(ms).getTimezoneOffset());
  });
});

describe("zoneNote", () => {
  test("before hydration the page is on the site's clock", () => {
    expect(zoneNote(SITE_TZ, -420)).toEqual({ kind: "site" });
  });

  test("a browser on UTC+8 keeps the site wording — the times did not change", () => {
    expect(zoneNote(undefined, SITE_UTC_OFFSET_MIN)).toEqual({ kind: "site" });
  });

  test("anywhere else names the reader's own offset", () => {
    expect(zoneNote(undefined, -420)).toEqual({ kind: "local", offset: "UTC−7" });
    expect(zoneNote(undefined, 0)).toEqual({ kind: "local", offset: "UTC" });
  });
});
