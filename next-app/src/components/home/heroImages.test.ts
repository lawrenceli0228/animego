import { describe, expect, test } from "bun:test";
import { PRODUCTION_MIRROR_BASE, mirrorOf, optimizedFrom, withMirror } from "@/lib/test-utils/nextImage";
import { heroBannerProps, heroCoverProps } from "./heroImages";

// What the homepage hero asks the optimizer for. getImageProps reads only the
// config a build inlines, so here it runs on Next's defaults (hence q=75 in
// the URLs and a warning about 85); the part pinned is where each image is
// fetched from.

const COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg";
const BANNER = "https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg";

/** Every URL an <img> with these props can request: src and each srcSet candidate. */
const requested = (props: { src?: string; srcSet?: string }) =>
  [props.src ?? "", ...(props.srcSet ?? "").split(", ").map((candidate) => candidate.split(" ")[0])].filter(Boolean);

describe("the homepage hero's images", () => {
  test.each([
    ["a cover", () => heroCoverProps(COVER), COVER],
    ["a banner", () => heroBannerProps(BANNER, true), BANNER],
    ["a cover standing in for a missing banner", () => heroBannerProps(COVER, false), COVER],
  ] as const)("%s comes from our mirror when switched on, from AniList when off", (_, props, anilist) => {
    const on = requested(withMirror(PRODUCTION_MIRROR_BASE, props));
    const off = requested(withMirror(undefined, props));
    expect(on.length).toBeGreaterThan(0);
    expect(off.length).toBe(on.length);
    for (const url of on) expect(url.startsWith(optimizedFrom(mirrorOf(anilist)))).toBe(true);
    for (const url of off) expect(url.startsWith(optimizedFrom(anilist))).toBe(true);
  });
});
