import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildJsonLd } from "@/components/anime/animeJsonLd";
import type { AnimeDetail } from "@/lib/types";
import { toMirrorUrl } from "./mirror";

// Which AniList URLs are rewritten to the mirror, and which are left alone.
// The set is nginx's allowlist for /img/anilist/: a URL outside it must stay
// on AniList, because nginx answers 404 for it.

const BASE = "https://animegoclub.com/img/anilist/";
const CDN = "https://s4.anilist.co/file/anilistcdn/";
const SWITCH = "NEXT_PUBLIC_IMAGE_MIRROR_BASE";

// bun runs every test file in one process: a switch left on here would
// rewrite the images in whichever file happens to run next.
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[SWITCH];
});
afterEach(() => {
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});

describe("with the mirror switched on", () => {
  beforeEach(() => {
    process.env[SWITCH] = BASE;
  });

  // [what it is, the path after /file/anilistcdn/]
  const MIRRORED: [string, string][] = [
    ["an anime cover, large", "media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg"],
    ["an anime cover, medium", "media/anime/cover/medium/bx154587-qQTzQnEJJ3oB.jpg"],
    ["an anime cover, extraLarge", "media/anime/cover/extraLarge/bx154587-qQTzQnEJJ3oB.png"],
    ["an anime cover, small", "media/anime/cover/small/bx154587-qQTzQnEJJ3oB.jpg"],
    ["a manga cover", "media/manga/cover/large/bx30002-7EzO7o21jzeF.jpg"],
    ["an anime banner", "media/anime/banner/154587-ivXNJ23SM1xB.jpg"],
    ["a manga banner", "media/manga/banner/30002-hbGd1eKmBRJl.jpg"],
    ["a character portrait, large", "character/large/b176754-5x6wfCKhRrxR.png"],
    ["a character portrait, medium", "character/medium/b176754-5x6wfCKhRrxR.png"],
    ["a staff portrait, large", "staff/large/n95991-0B7dPZHaFl9X.png"],
    ["a staff portrait, medium", "staff/medium/n95991-0B7dPZHaFl9X.png"],
    ["AniList's placeholder for a missing portrait", "character/large/default.jpg"],
    ["AniList's placeholder for a missing cover", "media/anime/cover/medium/default.jpg"],
    ["a legacy portrait with no hash in its name", "character/medium/4703.jpg"],
    ["a .jpeg", "media/anime/cover/large/bx1-x.jpeg"],
    ["a .gif", "media/anime/cover/large/bx1-x.gif"],
    ["a .webp", "media/anime/cover/large/bx1-x.webp"],
  ];

  test.each(MIRRORED)("%s goes to the mirror", (_, path) => {
    expect(toMirrorUrl(`${CDN}${path}`)).toBe(`${BASE}${path}`);
  });

  // [what it is, the input]
  const UNCHANGED: [string, string | null | undefined][] = [
    ["an AniList user avatar (same CDN prefix, not a kind the mirror serves)", `${CDN}user/avatar/large/b5375227-gXd6p2rIdE1h.png`],
    ["an AniList user banner", `${CDN}user/banner/b5375227-cVyYVtpLWb1f.jpg`],
    ["a cover size AniList does not publish", `${CDN}media/anime/cover/huge/bx1-x.jpg`],
    ["an extension outside the list", `${CDN}media/anime/cover/large/bx1-x.svg`],
    ["an upper-case extension (nginx matches case-sensitively)", `${CDN}media/anime/cover/large/bx1-x.JPG`],
    ["a query string", `${CDN}media/anime/cover/large/bx1-x.jpg?v=2`],
    ["a fragment", `${CDN}media/anime/cover/large/bx1-x.jpg#top`],
    ["a directory nested below the kind", `${CDN}media/anime/cover/large/extra/bx1-x.jpg`],
    ["a traversal attempt", `${CDN}media/anime/cover/large/../../../user/avatar/x.jpg`],
    ["a percent-encoded slash in the name", `${CDN}media/anime/cover/large/bx1%2Fx.jpg`],
    ["the CDN over plain http", "http://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-x.jpg"],
    ["AniList outside the CDN prefix", "https://s4.anilist.co/media/anime/cover/large/bx1-x.jpg"],
    ["the CDN prefix with nothing after it", CDN],
    ["a YouTube still", "https://i.ytimg.com/vi/kq6ZJNx2Mok/maxresdefault.jpg"],
    ["a Bangumi portrait", "https://lain.bgm.tv/pic/crt/l/1a/2b/95991_prsn_aBcDe.jpg?r=1700000000"],
    ["an image of our own", "/community-guide.jpg"],
    ["a URL that is already the mirror's", `${BASE}media/anime/cover/large/bx1-x.jpg`],
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
    ["a string that is not a URL", "not a url"],
  ];

  test.each(UNCHANGED)("%s is returned unchanged", (_, input) => {
    expect(toMirrorUrl(input)).toBe(input);
  });

  test("a base written without its trailing slash still yields exactly one", () => {
    process.env[SWITCH] = "https://animegoclub.com/img/anilist";
    expect(toMirrorUrl(`${CDN}character/large/default.jpg`)).toBe(`${BASE}character/large/default.jpg`);
  });

  test("never throws, whatever it is handed", () => {
    for (const odd of [42, {}, [], true, Symbol("s"), () => CDN]) {
      expect(() => toMirrorUrl(odd as never)).not.toThrow();
      expect(toMirrorUrl(odd as never)).toBe(odd as never);
    }
  });
});

describe("with the mirror switched off", () => {
  const COVER = `${CDN}media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg`;

  test("unset: an AniList cover stays on AniList", () => {
    delete process.env[SWITCH];
    expect(toMirrorUrl(COVER)).toBe(COVER);
  });

  test("empty, which is what the Docker build arg defaults to: unchanged", () => {
    process.env[SWITCH] = "";
    expect(toMirrorUrl(COVER)).toBe(COVER);
  });

  test("only whitespace: unchanged", () => {
    process.env[SWITCH] = "   ";
    expect(toMirrorUrl(COVER)).toBe(COVER);
  });

  test("the switch is read on every call, not once when the module loads", () => {
    delete process.env[SWITCH];
    expect(toMirrorUrl(COVER)).toBe(COVER);
    process.env[SWITCH] = BASE;
    expect(toMirrorUrl(COVER)).toBe(`${BASE}media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg`);
    delete process.env[SWITCH];
    expect(toMirrorUrl(COVER)).toBe(COVER);
  });
});

describe("where the rewrite does not reach", () => {
  test("structured data keeps AniList's image URL even with the switch on", () => {
    // Only rendered images move to the mirror. The JSON-LD image is a
    // statement about the work for search engines, and stays on AniList.
    process.env[SWITCH] = BASE;
    const cover = `${CDN}media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg`;
    const detail = {
      anilistId: 154587,
      titleRomaji: "Sousou no Frieren",
      titleChinese: "葬送的芙莉莲",
      coverImageUrl: cover,
      genres: [],
      studios: [],
      characters: [],
      staff: [],
    } as unknown as AnimeDetail;
    expect(buildJsonLd(detail, "zh").image).toBe(cover);
  });
});
