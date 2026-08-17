import "@/components/landing/shared/motion.css";
import type { Metadata } from "next";
import HeroSection from "@/components/landing/HeroSection";
import StatsRow from "@/components/landing/StatsRow";
import DataSourcesTribute from "@/components/landing/DataSourcesTribute";
import FeaturesBento from "@/components/landing/FeaturesBento";
import PosterIdentityShowcase from "@/components/landing/PosterIdentityShowcase";
import DifferentiatorSection from "@/components/landing/DifferentiatorSection";
import OpenSourceSection from "@/components/landing/OpenSourceSection";
import FaqSection from "@/components/landing/FaqSection";
import FinalCta from "@/components/landing/FinalCta";
import { apiGet, ApiError } from "@/lib/api";
import { getRepoStats } from "@/lib/github";
import { getDict, getLang } from "@/lib/i18n";
import { buildAlternates } from "@/lib/seo/alternates";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import type { AnimeDetail, TrendingItem } from "@/lib/types";

const FEATURE_POSTER_IDS = {
  frieren: 154587,
  apoth: 161645,
  losing: 171457,
} as const;

const TITLE_FIELDS: Array<keyof TrendingItem> = [
  "titleChinese",
  "titleRomaji",
  "titleEnglish",
  "titleNative",
];

function matchByTitle(
  list: TrendingItem[],
  patterns: string[],
): TrendingItem | undefined {
  const lowered = patterns.map((p) => p.toLowerCase());
  return list.find((a) => {
    const hay = TITLE_FIELDS.map((k) => (a[k] as string | null) || "")
      .join(" ")
      .toLowerCase();
    return lowered.some((p) => hay.includes(p));
  });
}

function pickShowcase(trending: TrendingItem[]): TrendingItem[] {
  const pick1 = matchByTitle(trending, ["我推的孩子", "Oshi no Ko", "推しの子"]);
  const pick2 = matchByTitle(trending, ["辉夜", "Kaguya", "かぐや"]);
  const pick3 = matchByTitle(trending, ["芙莉莲", "Frieren", "フリーレン"]);
  const used = new Set(
    [pick1, pick2, pick3].filter((p): p is TrendingItem => Boolean(p)).map((a) => a.anilistId),
  );
  const rest = [...trending.filter((a) => !used.has(a.anilistId))];
  const picks = [
    pick1 ?? rest.shift(),
    pick2 ?? rest.shift(),
    pick3 ?? rest.shift(),
  ];
  return picks.filter((p): p is TrendingItem => Boolean(p));
}

function pickFeaturePosters(trending: TrendingItem[]) {
  return {
    frieren: matchByTitle(trending, ["芙莉莲", "Frieren", "フリーレン"]) ?? null,
    apoth: matchByTitle(trending, ["药屋", "藥屋", "Apothecary", "Kusuriya", "薬屋"]) ?? null,
    losing: matchByTitle(trending, ["败犬", "敗犬", "Losing Heroines", "Makeine", "负け犬", "負けヒロイン"]) ?? null,
  };
}

async function safeDetail(id: number): Promise<AnimeDetail | null> {
  try {
    return await apiGet<AnimeDetail>(`/api/anime/${id}`, { revalidate: 3600 });
  } catch (err) {
    // Detail enrichment is non-fatal — fall back to the TrendingItem the
    // matchByTitle pick will provide. Log on the server for observability.
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn(`[LandingPage] anime detail ${id} failed:`, err);
    }
    return null;
  }
}

async function safeTrending(): Promise<TrendingItem[]> {
  try {
    return await apiGet<TrendingItem[]>(
      "/api/anime/trending?limit=30",
      { revalidate: 60 },
    );
  } catch (err) {
    console.warn("[LandingPage] trending fetch failed:", err);
    return [];
  }
}

// Resolve metadata on the server before render. Re-uses the same cached
// fetches as LandingPage() (revalidate 60/3600), so this does not double
// the API load -- Next memoizes fetch() within a request.
//
// OG image fallback chain (most-specific first):
//   1. frierenDetail.bannerImageUrl  (16:9 banner, ideal for social cards)
//   2. frierenDetail.coverImageUrl   (portrait poster)
//   3. trending[0].coverImageUrl     (fallback if Frieren detail 404s)
//   4. omit images                   (Next falls back to siteName card)
export async function generateMetadata(): Promise<Metadata> {
  const [dict, lang, frierenDetail, trending] = await Promise.all([
    getDict(),
    getLang(),
    safeDetail(FEATURE_POSTER_IDS.frieren),
    safeTrending(),
  ]);

  const heroImage =
    frierenDetail?.bannerImageUrl ||
    frierenDetail?.coverImageUrl ||
    trending[0]?.coverImageUrl ||
    null;

  const title = dict.landing.docTitle;
  const description = dict.landing.hero.sub;
  const locale = OG_LOCALE[lang];

  // Next 16 metadata merging is shallow across segments: setting `openGraph`
  // or `alternates` here REPLACES the layout's version wholesale. So we
  // re-emit the layout defaults (siteName, alternateLocale, hreflang
  // alternates) here to keep them on the rendered <head>.
  const openGraph: Metadata["openGraph"] = {
    title,
    description,
    siteName: "AnimeGoClub",
    locale,
    alternateLocale: alternateOgLocales(lang),
    type: "website",
    url: "/",
  };
  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title,
    description,
  };
  if (heroImage) {
    openGraph.images = [heroImage];
    twitter.images = [heroImage];
  }

  return {
    title: { absolute: title },
    description,
    openGraph,
    twitter,
    alternates: buildAlternates("/welcome"),
  };
}

export default async function LandingPage() {
  // `lang` is fetched beside `dict` and handed to the landing sections as a
  // sibling prop. Those sections used to infer their language by comparing
  // dictionary content against a Chinese sentinel ('。', '放送中'), which a
  // third language matches none of and so silently resolved to zh or en.
  // Sourcing both from the server here makes dict/lang disagreement impossible.
  const [dict, lang, trending, frierenDetail, apothDetail, losingDetail, repoStats] =
    await Promise.all([
      getDict(),
      getLang(),
      safeTrending(),
      safeDetail(FEATURE_POSTER_IDS.frieren),
      safeDetail(FEATURE_POSTER_IDS.apoth),
      safeDetail(FEATURE_POSTER_IDS.losing),
      getRepoStats(),
    ]);

  const trendingPosters = pickFeaturePosters(trending);
  // Feature cards prefer full detail (banner, accent) when available; fall
  // back to the trending row's lighter shape so the page never blanks if
  // detail enrichment lags.
  const featurePosters = {
    frieren: frierenDetail ?? trendingPosters.frieren ?? null,
    apoth: apothDetail ?? trendingPosters.apoth ?? null,
    losing: losingDetail ?? trendingPosters.losing ?? null,
  };

  // Random in-season cover for the §04 Member Pass card face (f8). Re-rolls
  // each ISR revalidation, so the showcase card cycles through real shows.
  const coverPool = trending.filter((t) => t.coverImageUrl);
  const memberCardArt = coverPool.length
    ? coverPool[Math.floor(Math.random() * coverPool.length)].coverImageUrl
    : null;
  // Profile-preview backdrop wants a wide 16:9 banner (covers crop badly in a
  // wide header). Only AnimeDetail carries bannerImageUrl, so pool the feature
  // details we already fetched.
  const bannerPool = [frierenDetail, apothDetail, losingDetail]
    .map((d) => d?.bannerImageUrl ?? null)
    .filter((b): b is string => Boolean(b));
  const memberCardBanner = bannerPool.length
    ? bannerPool[Math.floor(Math.random() * bannerPool.length)]
    : null;

  const showcase = pickShowcase(trending);
  const showcaseIds = new Set(showcase.map((a) => a.anilistId));
  const hero = featurePosters.frieren ?? trending[0] ?? null;
  const danmakuBg =
    matchByTitle(trending, ["鬼灭之刃", "Demon Slayer", "鬼滅の刃"]) ??
    trending.find((a) => !showcaseIds.has(a.anilistId) && a.anilistId !== hero?.anilistId) ??
    trending[3] ??
    trending[0] ??
    null;

  return (
    <main>
      <HeroSection dict={dict} lang={lang} poster={hero} />
      <StatsRow dict={dict} />
      <DataSourcesTribute dict={dict} />
      <FeaturesBento
        dict={dict}
        lang={lang}
        posters={featurePosters}
        memberCardArt={memberCardArt}
        memberCardBanner={memberCardBanner}
      />
      <PosterIdentityShowcase dict={dict} lang={lang} posters={showcase} />
      <OpenSourceSection
        dict={dict}
        lang={lang}
        stats={repoStats}
        poster={danmakuBg ?? featurePosters.apoth ?? hero}
      />
      <DifferentiatorSection dict={dict} />
      <FaqSection dict={dict} />
      <FinalCta dict={dict} lang={lang} />
    </main>
  );
}
