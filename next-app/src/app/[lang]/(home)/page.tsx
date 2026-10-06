import type { Metadata } from "next";
import type { CSSProperties } from "react";
import ContinueWatching from "@/components/anime/ContinueWatching";
import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import { currentSeasonHref } from "@/components/anime/continueWatchingState";
import GemsPanel from "@/components/home/GemsPanel";
import HomeHero from "@/components/home/HomeHero";
import HomeHueScope from "@/components/home/HomeHueScope";
import HueBrowser, { type HueFamilyView } from "@/components/home/HueBrowser";
import SeasonTopGrid from "@/components/home/SeasonTopGrid";
import TodayRail from "@/components/home/TodayRail";
import TrendingRanks from "@/components/home/TrendingRanks";
import YearTopList from "@/components/home/YearTopList";
import { seasonYearLabel } from "@/lib/contentLabels";
import { apiGet, apiGetPaged, ApiError } from "@/lib/api";
import type { Dict } from "@/lib/i18n";
import { upcomingAiring } from "@/lib/home/heroStatus";
import { colouredFirst, defaultFamily, groupByHueFamily, type HueFamilyKey } from "@/lib/home/hueFamilies";
import { dayHeader, fillTemplate } from "@/lib/home/time";
import { todayScheduleItems } from "@/lib/home/todaySlots";
import { fetchSchedule, fetchWatching } from "@/lib/schedule/fetch";
import {
  continueCards,
  gemCard,
  heroSlide,
  hueCard,
  seasonCard,
  todayCard,
  trendCard,
  yearCard,
  type ScheduleRow,
} from "@/lib/home/viewModels";
import { yearPath } from "@/lib/hubs/paths";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates, absoluteUrl, SITE_ORIGIN } from "@/lib/seo/alternates";
import type {
  ScheduleItem,
  SeasonalAnime,
  TrendingItem,
  YearlyTopItem,
} from "@/lib/types";
import styles from "./page.module.css";

// Phase 8.0: HomePage replaces the LandingPage at /. The marketing
// page moved to /welcome.
//
// dynamic = "force-dynamic", deliberately:
//
//   1. go-api is unreachable at `next build` (GO_API_INTERNAL_URL is a runtime
//      env, not a build arg), so ISR would prerender an EMPTY homepage and keep
//      serving it for the whole revalidate window after every deploy.
//   2. 继续看 renders the SIGNED-IN user's own watching list server-side
//      (the page reads the session cookie via apiGet), so the page is
//      genuinely per-user. (ActivityFeed used to be the second such section;
//      it left the homepage in the 2026-09 redesign.) Every load runs proxy.ts, which refreshes an
//      expiring session server-side BEFORE this render — so the chrome shows
//      logged-in without the client having to race a token refresh.
//
// History: PR #45 islanded these two sections (client fetch) + edge-cached `/`
// to speed up anonymous/crawler hits. That turned the homepage into a
// cached + per-user surface and repeatedly broke logged-in auth (the navbar
// flash #47, the login nav #48, and a refresh-token rotation race: proxy.ts and
// the client island both refreshing a 2-slot rotating token → eviction → 401
// storm → "logged out until refresh"). Reverted to server-render; the CF Cache
// Rule on `/` is dropped (anonymous now hits the origin, ~0.7s — acceptable).
// `/anime/*` keeps its edge cache (the larger, stable SEO win). Don't re-island
// `/` without solving the dual-refresher race first.
export const dynamic = "force-dynamic";

type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";

function getCurrentSeason(): Season {
  const m = new Date().getMonth() + 1;
  if (m <= 3) return "WINTER";
  if (m <= 6) return "SPRING";
  if (m <= 9) return "SUMMER";
  return "FALL";
}

// How much of the season one request brings back. The hero takes the top 5,
// 本季高分 the top 12, and 按色调逛 groups all of them by colour — so this is
// sized for the colour groups to have something in them, not for the grid.
// The endpoint is score-ordered and already filters adult titles.
const SEASON_ROWS = 48;
const HERO_COUNT = 5;
const SEASON_TOP_COUNT = 12;
/** Per colour family: six show on a wide screen, the rest scroll on a phone. */
const HUE_FAMILY_MAX = 10;
const TRENDING_COUNT = 10;
const COMPLETED_GEMS_LIMIT = 6;
const YEAR_TOP_COUNT = 10;

interface SeasonResult {
  rows: SeasonalAnime[];
  /** The whole season, for "本季全部 N 部" — not just the rows fetched. */
  total: number;
}

async function safeSeasonal(season: Season, year: number): Promise<SeasonResult> {
  try {
    // /seasonal answers {data, pagination:{total}} — not the flat envelope
    // ApiPagedEnvelope describes — so the total is read off `pagination`.
    const body = (await apiGetPaged<SeasonalAnime>(
      `/api/anime/seasonal?season=${season}&year=${year}&page=1&perPage=${SEASON_ROWS}`,
      { revalidate: 300 },
    )) as unknown as { data?: SeasonalAnime[]; pagination?: { total?: number } };
    const rows = Array.isArray(body.data) ? body.data : [];
    return { rows, total: body.pagination?.total ?? rows.length };
  } catch (err) {
    console.warn("[HomePage] seasonal fetch failed:", err);
    return { rows: [], total: 0 };
  }
}

async function safeTrending(): Promise<TrendingItem[]> {
  try {
    return await apiGet<TrendingItem[]>(`/api/anime/trending?limit=${TRENDING_COUNT}`, {
      revalidate: 60,
    });
  } catch (err) {
    console.warn("[HomePage] trending fetch failed:", err);
    return [];
  }
}

// A random sample per call; the section's "换一批" fetches the next one from
// the browser, so revalidate stays short.
async function safeCompletedGems(): Promise<TrendingItem[]> {
  try {
    return await apiGet<TrendingItem[]>(
      `/api/anime/completed-gems?limit=${COMPLETED_GEMS_LIMIT}`,
      { revalidate: 60 },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn("[HomePage] completed-gems fetch failed:", err);
    }
    return [];
  }
}

async function safeYearlyTop(year: number): Promise<YearlyTopItem[]> {
  try {
    return await apiGet<YearlyTopItem[]>(
      `/api/anime/yearly-top?year=${year}&limit=${YEAR_TOP_COUNT}`,
      { revalidate: 300 },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      console.warn("[HomePage] yearly-top fetch failed:", err);
    }
    return [];
  }
}

/**
 * This request's render time.
 *
 * A helper rather than `Date.now()` in the component body, which
 * react-hooks/purity rejects (same pattern as NotificationBell). A server
 * component renders once per request here — the page is force-dynamic — so
 * the value is simply "when this page was built". The clock-driven client
 * parts (hero status, today rail) start from it, so their first paint and
 * hydration agree, and switch to the browser's own clock after.
 */
function requestTime(): number {
  return Date.now();
}

const HUE_LABEL_KEY: Record<HueFamilyKey, keyof Dict["home"]> = {
  red: "hueRed",
  orange: "hueOrange",
  yellow: "hueYellow",
  green: "hueGreen",
  cyan: "hueCyan",
  blue: "hueBlue",
  purple: "huePurple",
};

// Visually-hidden style for the SEO <h1> — keeps the hero design intact
// while giving the homepage a brand+category primary heading.
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// schema.org Organization + WebSite for the homepage (the entity's
// canonical URL). inLanguage zh-CN + alternateName "AnimeGo" disambiguate
// us from the Russian piracy site "AnimeGO.org" that Google's AI Overview
// conflates with this brand; the SearchAction can earn a sitelinks box.
const HOME_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_ORIGIN}/#organization`,
      name: "AnimeGoClub",
      alternateName: "AnimeGo",
      url: SITE_ORIGIN,
      logo: absoluteUrl("/favicon-192.png"),
      description:
        "番剧追番与动漫发现平台 — 每季新番、评分、声优、弹幕评论与追番管理。",
      sameAs: ["https://github.com/lawrenceli0228/animego"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      url: SITE_ORIGIN,
      name: "AnimeGoClub",
      alternateName: "AnimeGo",
      inLanguage: "zh-CN",
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${absoluteUrl("/search")}?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    },
  ],
};

export async function generateMetadata({
  params,
}: PageProps<"/[lang]">): Promise<Metadata> {
  const { locale, dict } = await resolveLocale(params);
  // Homepage title + description lead with the brand and the 番剧 category
  // keyword (dict.meta.home*) so the brand+category query "animegoclub 番剧"
  // resolves to the homepage rather than a detail page.
  return {
    title: { absolute: dict.meta.homeTitle },
    description: dict.meta.homeDescription,
    alternates: buildAlternates("/", locale),
    openGraph: {
      title: dict.meta.homeTitle,
      description: dict.meta.homeDescription,
      url: "/",
      type: "website",
      images: ["/og-default.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: dict.meta.homeTitle,
      description: dict.meta.homeDescription,
      images: ["/og-default.png"],
    },
  };
}

export default async function HomePage({ params }: PageProps<"/[lang]">) {
  const season = getCurrentSeason();
  const year = new Date().getFullYear();

  const [{ dict, lang }, seasonal, trending, gems, schedule, yearlyTop, watching] =
    await Promise.all([
      resolveLocale(params),
      safeSeasonal(season, year),
      safeTrending(),
      safeCompletedGems(),
      // Shared with the schedule page (lib/schedule/fetch.ts): the 7-day
      // window, never cached, and the signed-in reader's watching list read
      // server-side with their cookie — anonymous on any failure.
      fetchSchedule("HomePage"),
      safeYearlyTop(year),
      fetchWatching(),
    ]);

  const nowMs = requestTime();
  const epCopy = { epUnit: dict.detail.epUnit, epUnitOne: dict.detail.epUnitOne };
  const scheduleRows: ScheduleRow[] = Object.values(schedule.groups ?? {}).flatMap(
    (items: ScheduleItem[] | undefined) => items ?? [],
  );
  const airingsFor = (id: number) =>
    scheduleRows.filter((r) => r.anilistId === id).map((r) => ({ at: r.airingAt * 1000, ep: r.episode }));

  // Still the season's top five, but the hero opens on a coloured one: its
  // first slide paints the whole page, and a colourless cover would open the
  // homepage grey.
  const slides = colouredFirst(
    seasonal.rows.slice(0, HERO_COUNT).map((row) => heroSlide(row, scheduleRows, lang)),
  );
  const seasonTop = seasonal.rows
    .slice(0, SEASON_TOP_COUNT)
    .map((row) => seasonCard(row, upcomingAiring(airingsFor(row.anilistId), nowMs), lang, epCopy));

  const hueGroups = groupByHueFamily(seasonal.rows.map((row) => hueCard(row, lang)));
  const families: HueFamilyView[] = hueGroups.map((g) => ({
    key: g.key,
    hue: g.hue,
    label: dict.home[HUE_LABEL_KEY[g.key]] as string,
    count: g.items.length,
    items: g.items.slice(0, HUE_FAMILY_MAX),
  }));
  const hueCount = hueGroups.reduce((n, g) => n + g.items.length, 0);

  const today = todayScheduleItems(schedule).map((row) => todayCard(row, lang));
  const progress = Object.fromEntries(watching.items.map((w) => [w.anilistId, w.currentEpisode]));
  const seasonName = seasonYearLabel(season, year, lang);
  const seasonHref = currentSeasonHref();

  return (
    <HomeHueScope hues={slides.map((s) => s.hue)}>
      {/* SEO: the homepage's primary heading is the brand + category, not
          the focused anime's title (an <h2> inside the hero). Visually
          hidden so the hero design is unchanged. */}
      <h1 style={SR_ONLY}>{dict.meta.homeH1}</h1>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HOME_JSON_LD) }}
      />
      {/* One subscription-set load backs the hero's 追番 button; anonymous
          visitors cost zero requests (see SubscriptionSetProvider). */}
      <SubscriptionSetProvider>
        <HomeHero slides={slides} serverNowMs={nowMs} progress={progress} />
      </SubscriptionSetProvider>
      <ContinueWatching
        items={continueCards(watching.items, lang)}
        loggedOut={watching.loggedOut}
        dict={dict}
        lang={lang}
        nowMs={nowMs}
        seasonHref={seasonHref}
      />
      {schedule.today ? (
        <TodayRail
          items={today}
          dayKey={schedule.today}
          dayLabel={dayHeader(schedule.today, lang)}
          serverNowMs={nowMs}
        />
      ) : null}
      <SeasonTopGrid
        items={seasonTop}
        dict={dict}
        seasonLabel={seasonName}
        seasonHref={seasonHref}
        total={seasonal.total}
      />
      {families.length > 0 ? (
        <HueBrowser
          title={dict.home.hueTitle}
          note={fillTemplate(dict.home.hueSub, { n: hueCount })}
          groupLabel={dict.home.hueGroup}
          countTemplate={dict.home.hueCount}
          families={families}
          defaultKey={defaultFamily(hueGroups) ?? families[0].key}
        />
      ) : null}
      <TrendingRanks
        items={trending.slice(0, TRENDING_COUNT).map((row) => trendCard(row, lang))}
        dict={dict}
      />
      <div className={styles.pair}>
        <GemsPanel initial={gems.map((row) => gemCard(row, lang, epCopy))} limit={COMPLETED_GEMS_LIMIT} />
        <YearTopList
          items={yearlyTop.slice(0, YEAR_TOP_COUNT).map((row, i) => yearCard(row, i + 1, lang))}
          title={fillTemplate(dict.home.yearTopTitle, { year })}
          note={dict.home.yearTopSub}
          link={{ href: yearPath(year), label: dict.home.yearTopAll }}
        />
      </div>
    </HomeHueScope>
  );
}
