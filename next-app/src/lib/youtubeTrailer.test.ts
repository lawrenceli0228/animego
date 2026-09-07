import { describe, expect, test } from "bun:test";
import {
  asYouTubeTrailer,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
  youtubeWatchUrl,
} from "./youtubeTrailer";

describe("YouTube trailer wire values", () => {
  test("accepts the complete YouTube id alphabet and normalises the site", () => {
    expect(asYouTubeTrailer({ id: "a-b_c1D2e3F", site: "YouTube" })).toEqual({
      id: "a-b_c1D2e3F",
      site: "youtube",
    });
  });

  test("fails closed for partial or malformed pairs", () => {
    expect(asYouTubeTrailer(null)).toBeNull();
    expect(asYouTubeTrailer({ id: null, site: "youtube" })).toBeNull();
    expect(asYouTubeTrailer({ id: "abcdefghijk", site: null })).toBeNull();
    expect(asYouTubeTrailer({ id: "short", site: "youtube" })).toBeNull();
    expect(asYouTubeTrailer({ id: "https://evil", site: "youtube" })).toBeNull();
    expect(asYouTubeTrailer({ id: "abcdefghijk", site: "dailymotion" })).toBeNull();
  });
});

test("URL builders keep the validated id in its expected URL slot", () => {
  const id = "a-b_c1D2e3F";
  expect(youtubeThumbnailUrl(id)).toBe(
    "https://i.ytimg.com/vi/a-b_c1D2e3F/maxresdefault.jpg",
  );
  expect(youtubeThumbnailUrl(id, "hqdefault")).toBe(
    "https://i.ytimg.com/vi/a-b_c1D2e3F/hqdefault.jpg",
  );
  expect(youtubeEmbedUrl(id)).toBe(
    "https://www.youtube-nocookie.com/embed/a-b_c1D2e3F?autoplay=1&rel=0&playsinline=1",
  );
  expect(youtubeWatchUrl(id)).toBe(
    "https://www.youtube.com/watch?v=a-b_c1D2e3F",
  );
});
