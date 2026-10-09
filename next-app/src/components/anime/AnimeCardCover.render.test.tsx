import { describe, expect, test } from "bun:test";

import {
  APP_IMAGE_CONFIG,
  PRODUCTION_MIRROR_BASE,
  imgSrcs,
  mirrorOf,
  optimizedFrom,
  renderAsNextDev,
  withMirror,
} from "@/lib/test-utils/nextImage";
import AnimeCardCover from "./AnimeCardCover";

// The cover every AnimeCard draws (seasonal, search, rankings), rendered as
// `next dev` renders it: next/image checks the src against the app's
// remotePatterns and throws on one it does not admit. AnimeCard itself cannot
// be imported here (see AnimeCardCover.tsx), so this is the card's image,
// rendered by the component the card renders it with.

const COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg";

const render = (src: string | null) =>
  renderAsNextDev(<AnimeCardCover src={src} title="葬送的芙莉莲" priority={false} />);

describe("AnimeCard's cover", () => {
  test("switched on: optimized from our mirror", () => {
    const srcs = withMirror(PRODUCTION_MIRROR_BASE, () => imgSrcs(render(COVER)));
    expect(srcs).toHaveLength(1);
    expect(srcs[0].startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
  });

  test("switched off: optimized from AniList", () => {
    const srcs = withMirror(undefined, () => imgSrcs(render(COVER)));
    expect(srcs).toHaveLength(1);
    expect(srcs[0].startsWith(optimizedFrom(COVER))).toBe(true);
  });

  test("a row that already holds the mirror's URL renders either way", () => {
    for (const base of [PRODUCTION_MIRROR_BASE, undefined]) {
      const srcs = withMirror(base, () => imgSrcs(render(mirrorOf(COVER))));
      expect(srcs[0].startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
    }
  });

  test("the srcset is the 1x/2x pair, both from the same source", () => {
    const html = withMirror(PRODUCTION_MIRROR_BASE, () => render(COVER));
    const srcSet = /srcSet="([^"]*)"/.exec(html)?.[1].replaceAll("&amp;", "&") ?? "";
    const candidates = srcSet.split(", ");
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) expect(candidate.startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
  });

  test("no cover: the placeholder box, and no image", () => {
    const html = withMirror(PRODUCTION_MIRROR_BASE, () => render(null));
    expect(imgSrcs(html)).toEqual([]);
    expect(html).toContain('aria-hidden="true"');
  });

  test("the check is live: with the mirror missing from remotePatterns, the same render throws", () => {
    const withoutMirror = {
      ...APP_IMAGE_CONFIG,
      remotePatterns: APP_IMAGE_CONFIG.remotePatterns.filter(
        (p) => !(p instanceof URL) && p.hostname !== "animegoclub.com",
      ),
    };
    const card = <AnimeCardCover src={COVER} title="葬送的芙莉莲" priority={false} />;
    expect(() => withMirror(PRODUCTION_MIRROR_BASE, () => renderAsNextDev(card, withoutMirror))).toThrow(
      /is not configured under images/,
    );
  });
});
