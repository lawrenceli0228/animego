import { describe, expect, test } from "bun:test";
import { formatReleaseDate, formatSize } from "./format";

/** The same instant, as this machine's calendar day — keeps the assertions zone-independent. */
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("formatReleaseDate", () => {
  test("RFC 3339 (what go-api sends)", () => {
    expect(formatReleaseDate("2026-08-11T22:07:00Z")).toBe(localDay("2026-08-11T22:07:00Z"));
    expect(formatReleaseDate("2026-08-11T22:07:00.000Z")).toBe(localDay("2026-08-11T22:07:00Z"));
  });

  test("RFC 1123 from the RSS feeds still reads", () => {
    expect(formatReleaseDate("Sat, 22 Aug 2026 21:17:35 +0800")).toBe(localDay("2026-08-22T13:17:35Z"));
    expect(formatReleaseDate("Sat, 12 Sep 2026 15:45:00 -0000")).toBe(localDay("2026-09-12T15:45:00Z"));
  });

  test("Mikan's zoneless time is UTC+8", () => {
    expect(formatReleaseDate("2026-05-11T17:35:00")).toBe(localDay("2026-05-11T09:35:00Z"));
  });

  test("missing or unreadable → empty", () => {
    expect(formatReleaseDate(null)).toBe("");
    expect(formatReleaseDate("")).toBe("");
    expect(formatReleaseDate("not a date")).toBe("");
  });
});

describe("formatSize", () => {
  test("binary units are named like decimal ones", () => {
    expect(formatSize("6.6 GiB")).toBe("6.6 GB");
    expect(formatSize("352 MiB")).toBe("352 MB");
    expect(formatSize("4.5 GB")).toBe("4.5 GB");
    expect(formatSize("812 MB")).toBe("812 MB");
  });

  test("the 0 KB placeholder and other non-sizes show nothing", () => {
    expect(formatSize("0 KB")).toBe("");
    expect(formatSize("")).toBe("");
    expect(formatSize(null)).toBe("");
    expect(formatSize("12 B")).toBe("");
    expect(formatSize("unknown")).toBe("");
  });
});
