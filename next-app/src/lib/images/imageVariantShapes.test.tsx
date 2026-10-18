import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import ts from "typescript";

import DetailHero from "@/app/[lang]/anime/[id]/_detail/DetailHero";
import {
  PORTRAIT_H,
  PORTRAIT_W,
  POSTER_SRC_H,
  POSTER_SRC_W,
  STAFF_AVATAR,
} from "@/app/[lang]/anime/[id]/_detail/sectionImageSizes";
import BrowseView from "@/components/seasonal/browse/BrowseView";
import type { FollowSlotProps } from "@/components/seasonal/browse/types";
import FadeImage from "@/components/ui/FadeImage";
import { LanguageProvider } from "@/lib/lang-client";
import { DEFAULT_STATE, type BrowseState } from "@/lib/seasonal/state";
import { APP_IMAGE_CONFIG, PRODUCTION_MIRROR_BASE, renderAsNextDev, withMirror } from "@/lib/test-utils/nextImage";
import { NOW, item } from "@/lib/test-utils/seasonalItems";
import type { AnimeDetail } from "@/lib/types";
import zh from "@/locales/zh";

// nginx keeps the "page shapes" -- the AVIF variants of AniList covers,
// banners and portraits at the widths the pages ask for -- in a cache zone of
// their own, and the warm job (go-api, image_variant_warm) encodes every one
// of them a show's page shows before a reader asks.  Both work from the list
// in the $next_image_zone map of nginx/default.p9.conf.  A page that starts
// asking for a width that list does not hold breaks nothing visible: its
// variants just land in the other zone, are never warmed, and an old show's
// page is slow again.  So this file renders the images of the detail page
// and the season page, with the app's own image sizes, and holds every
// variant they ask for to that list.

const ROOT = join(import.meta.dir, "../../../..");
const ANILIST = "https://s4.anilist.co/file/anilistcdn/";

/** The page-shape regexes, exactly as nginx has them. */
function pageShapeRegexes(): RegExp[] {
  const conf = readFileSync(join(ROOT, "nginx/default.p9.conf"), "utf8");
  const block = conf.match(/^map "\$next_image_key_args\|\$next_image_fmt" \$next_image_zone \{\n([\s\S]*?)\n\}/m);
  if (!block) throw new Error("no $next_image_zone map in nginx/default.p9.conf");
  const lines = block[1].split("\n").map((l) => l.trim());
  expect(lines[0]).toBe("default next_image_misc;");
  return lines.slice(1).map((line) => {
    const m = line.match(/^"~(.+)" next_image;$/);
    if (!m) throw new Error(`unexpected line in the $next_image_zone map: ${line}`);
    return new RegExp(m[1]);
  });
}

/** One numeric array property of next.config.ts's images block, read from the source. */
function nextConfigSizes(name: string): number[] {
  const file = join(ROOT, "next-app/next.config.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: number[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name && ts.isArrayLiteralExpression(node.initializer)) {
      found.push(node.initializer.elements.map((e) => Number(e.getText(source).replaceAll("_", ""))));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new Error(`expected one images.${name} in next.config.ts, found ${found.length}`);
  return found[0];
}

const CONFIG = {
  ...APP_IMAGE_CONFIG,
  deviceSizes: nextConfigSizes("deviceSizes"),
  imageSizes: nextConfigSizes("imageSizes"),
  qualities: nextConfigSizes("qualities"),
};

/** Every AniList variant some markup asks the optimizer for: src and every srcset candidate. */
function anilistVariants(html: string): { path: string; w: number; q: number }[] {
  const out: { path: string; w: number; q: number }[] = [];
  for (const m of html.matchAll(/\/_next\/image\?url=([^&"\s]+)&(?:amp;)?w=(\d+)&(?:amp;)?q=(\d+)/g)) {
    const url = decodeURIComponent(m[1]);
    const path = url.startsWith(PRODUCTION_MIRROR_BASE)
      ? url.slice(PRODUCTION_MIRROR_BASE.length)
      : url.startsWith(ANILIST)
        ? url.slice(ANILIST.length)
        : null;
    if (path !== null) out.push({ path, w: Number(m[2]), q: Number(m[3]) });
  }
  return out;
}

/** The key nginx files a variant under, as an AVIF request from a browser. */
function nginxKey(v: { path: string; w: number; q: number }): string {
  return `url=${encodeURIComponent(ANILIST + v.path)}&w=${v.w}&q=${v.q}|avif`;
}

const render = (ui: ReactElement) => withMirror(PRODUCTION_MIRROR_BASE, () => renderAsNextDev(ui, CONFIG));

const COVER_LARGE = `${ANILIST}media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg`;
const COVER_MEDIUM = `${ANILIST}media/anime/cover/medium/b21-YCDoj1EkAxFn.jpg`;
const MANGA_COVER = `${ANILIST}media/manga/cover/medium/bx30002-7EzO7o21jzeF.jpg`;
const BANNER = `${ANILIST}media/anime/banner/154587-ivXNJ23SM1xB.jpg`;
const CHARACTER = `${ANILIST}character/medium/b183965-HuR5Fc4gnY96.png`;
const PERSON = `${ANILIST}staff/medium/n150456-88d5OFEmD4Sj.png`;

function detail(): AnimeDetail {
  return {
    anilistId: 154587,
    titleRomaji: "Sousou no Frieren",
    titleEnglish: "Frieren: Beyond Journey's End",
    titleNative: "葬送のフリーレン",
    titleChinese: "葬送的芙莉莲",
    coverImageUrl: COVER_LARGE,
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
  } as AnimeDetail;
}

function StubFollow({ anilistId }: FollowSlotProps) {
  return <i data-stub-follow={anilistId} />;
}

function seasonPage(view: BrowseState["view"]): string {
  const items = [COVER_LARGE, COVER_MEDIUM].map((cover, i) =>
    item({ id: 9000 + i, title: `测试番 ${i}`, rank: i, titleRank: i, popularity: 100 - i, cover }),
  );
  return render(
    <LanguageProvider lang="zh">
      <BrowseView
        items={items}
        initial={{ ...DEFAULT_STATE, view }}
        serverNowMs={NOW}
        season="fall"
        year={2026}
        clockYear={2026}
        heading="2026年 秋季新番"
        Follow={StubFollow}
      />
    </LanguageProvider>,
  );
}

const SURFACES: [string, () => string][] = [
  [
    "the detail page's hero (banner, cover)",
    () =>
      render(
        <LanguageProvider lang="zh">
          <DetailHero detail={detail()} lang="zh" dict={zh} />
        </LanguageProvider>,
      ),
  ],
  [
    "a related work or recommendation poster (anime and manga)",
    () =>
      render(
        <>
          <FadeImage src={COVER_MEDIUM} alt="" width={POSTER_SRC_W} height={POSTER_SRC_H} />
          <FadeImage src={MANGA_COVER} alt="" width={POSTER_SRC_W} height={POSTER_SRC_H} />
          <FadeImage src={COVER_LARGE} alt="" width={POSTER_SRC_W} height={POSTER_SRC_H} />
        </>,
      ),
  ],
  [
    "a character and its voice actor",
    () =>
      render(
        <>
          <FadeImage src={CHARACTER} alt="" width={PORTRAIT_W} height={PORTRAIT_H} />
          <FadeImage src={PERSON} alt="" width={PORTRAIT_W} height={PORTRAIT_H} />
        </>,
      ),
  ],
  ["a staff member", () => render(<FadeImage src={PERSON} alt="" width={STAFF_AVATAR} height={STAFF_AVATAR} />)],
  ["the season page's grid", () => seasonPage("grid")],
  ["the season page's chart cards", () => seasonPage("chart")],
  ["the season page's list", () => seasonPage("table")],
];

describe("every AniList variant the detail and season pages ask for is a page shape nginx keeps", () => {
  const shapes = pageShapeRegexes();

  test("nginx lists four kinds of page shape", () => {
    expect(shapes).toHaveLength(4);
  });

  for (const [surface, html] of SURFACES) {
    test(surface, () => {
      const variants = anilistVariants(html());
      expect(variants.length).toBeGreaterThan(0);
      const outside = variants.filter((v) => !shapes.some((re) => re.test(nginxKey(v))));
      expect(outside.map((v) => `${v.path} w=${v.w} q=${v.q}`)).toEqual([]);
    });
  }

  test("the widths these pages ask for, by kind (what the warm job's list is drawn from)", () => {
    const widths = new Map<string, Set<number>>();
    for (const [, html] of SURFACES) {
      for (const v of anilistVariants(html())) {
        const kind = v.path.split("/").slice(0, -1).join("/");
        widths.set(kind, (widths.get(kind) ?? new Set()).add(v.w));
      }
    }
    const sorted = (kind: string) => [...(widths.get(kind) ?? [])].sort((a, b) => a - b);
    expect(sorted("media/anime/banner")).toEqual([640, 828, 1080, 1200, 1920]);
    expect(sorted("media/anime/cover/large")).toEqual([64, 96, 256, 384, 640]);
    expect(sorted("media/anime/cover/medium")).toEqual([64, 96, 256, 384]);
    expect(sorted("media/manga/cover/medium")).toEqual([256, 384]);
    expect(sorted("character/medium")).toEqual([64, 128]);
    expect(sorted("staff/medium")).toEqual([64, 96, 128]);
  });
});
