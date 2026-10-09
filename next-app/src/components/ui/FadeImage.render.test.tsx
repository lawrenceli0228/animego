import { describe, expect, test } from "bun:test";

import {
  PRODUCTION_MIRROR_BASE,
  imgSrcs,
  mirrorOf,
  optimizedFrom,
  renderAsNextDev,
  withMirror,
} from "@/lib/test-utils/nextImage";
import FadeImage from "./FadeImage";

// FadeImage is where most of the site's images meet the mirror and the
// optimizer's allowlist. Rendered as `next dev` renders it (see
// lib/test-utils/nextImage.tsx): a src handed to next/image that the
// allowlist refuses throws here, as it would on a server-rendered page.

const COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg";

const render = (src: string | null, unoptimized?: boolean) =>
  renderAsNextDev(<FadeImage src={src} alt="" width={180} height={240} unoptimized={unoptimized} />);

describe("FadeImage and the AniList mirror", () => {
  test("switched on, an AniList cover is optimized from the mirror", () => {
    const [src] = withMirror(PRODUCTION_MIRROR_BASE, () => imgSrcs(render(COVER)));
    expect(src.startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
  });

  test("switched off, from AniList", () => {
    const [src] = withMirror(undefined, () => imgSrcs(render(COVER)));
    expect(src.startsWith(optimizedFrom(COVER))).toBe(true);
  });

  test("a caller's own `unoptimized` keeps the src exactly as given, switch on or off", () => {
    // The library and player surfaces: srcs out of IndexedDB, kept away from
    // our servers, the mirror included.
    for (const base of [PRODUCTION_MIRROR_BASE, undefined]) {
      expect(withMirror(base, () => imgSrcs(render(COVER, true)))).toEqual([COVER]);
    }
  });
});

describe("FadeImage never hands next/image a src it would refuse", () => {
  // Each of these used to reach next/image as optimizable, which under
  // `next dev` is a throw while rendering. They are drawn as a plain <img>.
  test.each([
    ["a Bangumi portrait with its cache-busting query", "https://lain.bgm.tv/pic/crt/l/1a/2b/95991_prsn_aBcDe.jpg?r=1700000000"],
    ["an AniList URL with a query string", `${COVER}?v=2`],
    ["AniList over plain http", COVER.replace("https:", "http:")],
    ["a protocol-relative URL", COVER.replace("https:", "")],
    ["a path on this site with a query string", "/community-guide.jpg?v=2"],
    ["a string that is not a URL", "not a url"],
  ])("%s", (_, src) => {
    for (const base of [PRODUCTION_MIRROR_BASE, undefined]) {
      expect(withMirror(base, () => imgSrcs(render(src)))).toEqual([src]);
    }
  });

  test("a path on this site is still optimized", () => {
    const [src] = imgSrcs(render("/community-guide.jpg"));
    expect(src.startsWith(optimizedFrom("/community-guide.jpg"))).toBe(true);
  });

  test("no src: the placeholder box, and no image", () => {
    expect(imgSrcs(render(null))).toEqual([]);
  });
});
