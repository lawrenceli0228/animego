import { describe, expect, test } from "bun:test";
import { resolveWatchingTotal } from "./continueWatchingState";
import type { WatchingItem } from "@/lib/types";

const item = (over: Partial<WatchingItem>): WatchingItem =>
  ({ anilistId: 1, currentEpisode: 0, episodes: null, ...over }) as WatchingItem;

describe("resolveWatchingTotal", () => {
  // The bug this exists for: with episodes null the card printed the CURRENT
  // episode alone, so a reader on episode 7 of a show with no AniList count saw
  // "7 集" — a position rendered as a total, and no progress bar at all.
  test("falls back to the inferred count when AniList has none", () => {
    expect(resolveWatchingTotal(item({ episodes: null, episodesBgm: 12 }))).toBe(12);
  });

  test("the authoritative count always wins", () => {
    expect(resolveWatchingTotal(item({ episodes: 13, episodesBgm: 26 }))).toBe(13);
  });

  test("neither known stays null so the bar is suppressed, not drawn at zero", () => {
    expect(resolveWatchingTotal(item({ episodes: null }))).toBeNull();
    expect(resolveWatchingTotal(item({ episodes: null, episodesBgm: null }))).toBeNull();
  });

  // A go-api older than this change omits the field entirely.
  test("a missing field is not an error", () => {
    expect(resolveWatchingTotal(item({ episodes: 12 }))).toBe(12);
    expect(resolveWatchingTotal(item({}))).toBeNull();
  });

  // 0 and negatives mean "unknown" everywhere else in this codebase.
  test("zero and negative are unknown, not a total", () => {
    expect(resolveWatchingTotal(item({ episodes: 0, episodesBgm: 12 }))).toBe(12);
    expect(resolveWatchingTotal(item({ episodes: 0, episodesBgm: 0 }))).toBeNull();
    expect(resolveWatchingTotal(item({ episodes: -1 }))).toBeNull();
  });
});
