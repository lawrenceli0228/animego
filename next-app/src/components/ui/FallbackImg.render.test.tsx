import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PRODUCTION_MIRROR_BASE, mirrorOf, optimizedFrom, withMirror } from "@/lib/test-utils/nextImage";
import FallbackImg from "./FallbackImg";

// FallbackImg draws the avatar of every member without a photo: the cover of
// the anime they picked, an AniList URL, in the navbar on every page and in
// every comment and watcher row. That cover comes through the optimizer from
// our mirror; a member's own photo and the default card are used as given.

const COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg";
const DEFAULT = "/card_default/card.jpg";

const srcOf = (html: string) => {
  const m = html.match(/ src="([^"]*)"/);
  if (!m) throw new Error(`no src in ${html}`);
  return m[1].replaceAll("&amp;", "&");
};

const render = (src: string, width?: number) =>
  srcOf(renderToStaticMarkup(<FallbackImg src={src} fallback={DEFAULT} alt="" width={width} />));

describe("FallbackImg", () => {
  test("a cover standing in for an avatar comes from our mirror, through the optimizer", () => {
    expect(withMirror(PRODUCTION_MIRROR_BASE, () => render(COVER)).startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
  });

  test("with the mirror switched off it still goes through the optimizer, from AniList", () => {
    expect(withMirror(undefined, () => render(COVER)).startsWith(optimizedFrom(COVER))).toBe(true);
  });

  test("a wider width asks for a wider variant", () => {
    const w = (src: string) => Number(new URL(src, "https://x").searchParams.get("w"));
    withMirror(PRODUCTION_MIRROR_BASE, () => expect(w(render(COVER, 290))).toBeGreaterThan(w(render(COVER))));
  });

  test.each([
    ["a member's own photo", "/api/avatars/3f2c.jpg"],
    ["the default card", DEFAULT],
  ])("%s is used as given", (_, src) => {
    expect(withMirror(PRODUCTION_MIRROR_BASE, () => render(src))).toBe(src);
  });
});
