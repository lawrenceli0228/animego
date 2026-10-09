import { describe, expect, test } from "bun:test";
import { PRODUCTION_MIRROR_BASE, mirrorOf, optimizedFrom, withMirror } from "@/lib/test-utils/nextImage";
import { anilistImageSrc, anilistImgProps } from "./anilistImg";

// Where a plain <img> or a CSS background gets an image from. getImageProps
// reads only the config a build inlines, so under test it runs on Next's
// default widths and quality; the part pinned here is the source.

const COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg";
const BANNER = "https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg";
const PORTRAIT = "https://s4.anilist.co/file/anilistcdn/character/medium/b176754-pc3ewUfuR3cr.png";

/** Every URL an <img> with these props can request: src and each srcSet candidate. */
const requested = (props: { src?: string; srcSet?: string }) =>
  [props.src ?? "", ...(props.srcSet ?? "").split(", ").map((candidate) => candidate.split(" ")[0])].filter(Boolean);

describe("anilistImgProps", () => {
  test.each([COVER, BANNER, PORTRAIT])("%s comes from our mirror when switched on, from AniList when off", (url) => {
    const on = withMirror(PRODUCTION_MIRROR_BASE, () => anilistImgProps(url, 120, 170));
    const off = withMirror(undefined, () => anilistImgProps(url, 120, 170));

    expect(on.srcSet?.split(", ")).toHaveLength(2);
    for (const u of requested(on)) expect(u.startsWith(optimizedFrom(mirrorOf(url)))).toBe(true);
    for (const u of requested(off)) expect(u.startsWith(optimizedFrom(url))).toBe(true);
  });

  test.each([
    ["a member's own photo", "/api/avatars/3f2c.jpg"],
    ["the default card", "/card_default/card.jpg"],
    ["a blob preview", "blob:https://animegoclub.com/1b2c"],
    ["a data URL", "data:image/png;base64,iVBORw0KGgo="],
    ["a Bangumi portrait", "https://lain.bgm.tv/pic/crt/l/ab/cd/1_crt_x.jpg?r=1"],
    ["an AniList user upload, which the mirror does not serve", "https://s4.anilist.co/file/anilistcdn/user/avatar/large/b5123-x.png"],
    ["an AniList URL with a query string", `${COVER}?v=2`],
    ["a string that is not a URL", "not a url"],
  ])("%s is used exactly as given, with no srcSet", (_, url) => {
    const props = withMirror(PRODUCTION_MIRROR_BASE, () => anilistImgProps(url, 120, 170));
    expect(props).toEqual({ src: url });
  });
});

describe("anilistImageSrc", () => {
  test("one optimizer URL for an AniList image, the larger of the two the <img> props offer", () => {
    withMirror(PRODUCTION_MIRROR_BASE, () => {
      const src = anilistImageSrc(BANNER, 244);
      expect(src.startsWith(optimizedFrom(mirrorOf(BANNER)))).toBe(true);
      expect(src).toBe(anilistImgProps(BANNER, 244, 244).src);
      const widths = requested(anilistImgProps(BANNER, 244, 244)).map((u) => Number(new URL(u, "https://x").searchParams.get("w")));
      expect(Number(new URL(src, "https://x").searchParams.get("w"))).toBe(Math.max(...widths));
    });
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a member's own photo", "/api/avatars/3f2c.jpg"],
    ["the default backdrop", "/card_default/backdrop.jpg"],
  ])("%s passes through", (_, url) => {
    expect(withMirror(PRODUCTION_MIRROR_BASE, () => anilistImageSrc(url, 1920))).toBe(url as never);
  });
});
