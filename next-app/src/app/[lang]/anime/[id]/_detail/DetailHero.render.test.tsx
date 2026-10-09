import { describe, expect, test } from "bun:test";

import { LanguageProvider } from "@/lib/lang-client";
import {
  APP_IMAGE_CONFIG,
  PRODUCTION_MIRROR_BASE,
  imgSrcs,
  mirrorOf,
  optimizedFrom,
  renderAsNextDev,
  withMirror,
} from "@/lib/test-utils/nextImage";
import type { AnimeDetail } from "@/lib/types";
import zh from "@/locales/zh";
import DetailHero from "./DetailHero";

// The hero every /anime/[id] tab opens with, rendered on the server the way
// `next dev` renders it: next/image checks each src against the app's
// remotePatterns and throws on one it does not admit, and a throw here is a
// 500 for every tab of the title. Two images: the banner, which is next/image
// directly and so does its own mirror rewrite, and the cover, which goes
// through FadeImage.
//
// The dictionary is imported directly rather than through getDictByLang, as
// in DetailTabs.render.test.tsx: admin/_actions/users.test.ts replaces
// @/lib/i18n with a stub for the rest of the run.

const BANNER = "https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg";
const COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg";

function detail(over: Partial<AnimeDetail> = {}): AnimeDetail {
  return {
    anilistId: 154587,
    titleRomaji: "Sousou no Frieren",
    titleEnglish: "Frieren: Beyond Journey's End",
    titleNative: "葬送のフリーレン",
    titleChinese: "葬送的芙莉莲",
    coverImageUrl: COVER,
    bannerImageUrl: BANNER,
    averageScore: 91,
    status: "FINISHED",
    episodes: 28,
    duration: 24,
    genres: ["Adventure", "Drama"],
    episodeTitles: [],
    bgmId: null,
    bangumiScore: null,
    bangumiVotes: null,
    nextAiring: null,
    ...over,
  } as AnimeDetail;
}

const render = (d: AnimeDetail) =>
  renderAsNextDev(
    <LanguageProvider lang="zh">
      <DetailHero detail={d} lang="zh" dict={zh} />
    </LanguageProvider>,
  );

describe("DetailHero — banner and cover", () => {
  test("switched on: the banner and the cover are both optimized from our mirror", () => {
    const [banner, cover, ...rest] = withMirror(PRODUCTION_MIRROR_BASE, () => imgSrcs(render(detail())));
    expect(rest).toEqual([]);
    expect(banner.startsWith(optimizedFrom(mirrorOf(BANNER)))).toBe(true);
    expect(cover.startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
  });

  test("switched off: both are optimized from AniList", () => {
    const [banner, cover, ...rest] = withMirror(undefined, () => imgSrcs(render(detail())));
    expect(rest).toEqual([]);
    expect(banner.startsWith(optimizedFrom(BANNER))).toBe(true);
    expect(cover.startsWith(optimizedFrom(COVER))).toBe(true);
  });

  test("a row that already holds the mirror's URLs renders either way", () => {
    const mirrored = detail({ bannerImageUrl: mirrorOf(BANNER), coverImageUrl: mirrorOf(COVER) });
    for (const base of [PRODUCTION_MIRROR_BASE, undefined]) {
      const [banner, cover] = withMirror(base, () => imgSrcs(render(mirrored)));
      expect(banner.startsWith(optimizedFrom(mirrorOf(BANNER)))).toBe(true);
      expect(cover.startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
    }
  });

  test("no banner: only the cover is drawn", () => {
    const srcs = withMirror(PRODUCTION_MIRROR_BASE, () => imgSrcs(render(detail({ bannerImageUrl: null }))));
    expect(srcs).toHaveLength(1);
    expect(srcs[0].startsWith(optimizedFrom(mirrorOf(COVER)))).toBe(true);
  });

  test("the check is live: with the mirror missing from remotePatterns, the same render throws", () => {
    // What a build with the switch on and the allowlist entry forgotten would
    // do. The banner is next/image directly, so nothing stands between it and
    // the check.
    const withoutMirror = {
      ...APP_IMAGE_CONFIG,
      remotePatterns: APP_IMAGE_CONFIG.remotePatterns.filter(
        (p) => !(p instanceof URL) && p.hostname !== "animegoclub.com",
      ),
    };
    const page = (
      <LanguageProvider lang="zh">
        <DetailHero detail={detail()} lang="zh" dict={zh} />
      </LanguageProvider>
    );
    expect(() => withMirror(PRODUCTION_MIRROR_BASE, () => renderAsNextDev(page, withoutMirror))).toThrow(
      /is not configured under images/,
    );
    expect(() => withMirror(undefined, () => renderAsNextDev(page, withoutMirror))).not.toThrow();
  });
});
