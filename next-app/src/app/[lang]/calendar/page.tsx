import type { Metadata } from "next";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import NextSeasonLink from "@/components/schedule/NextSeasonLink";
import ScheduleBoard from "@/components/schedule/ScheduleBoard";
import ScheduleHeader from "@/components/schedule/ScheduleHeader";
import SignInPrompt from "@/components/schedule/SignInPrompt";
import { seasonYearLabel } from "@/lib/contentLabels";
import { fillTemplate } from "@/lib/home/time";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { fetchSchedule, fetchSeasonTotal, fetchWatching } from "@/lib/schedule/fetch";
import { nextSeasonOf, seasonHref, seasonOf, startMonthLabel } from "@/lib/schedule/season";
import { buildWeek } from "@/lib/schedule/viewModels";
import { buildAlternates } from "@/lib/seo/alternates";

// The schedule page, B 逐番色: a week of airings by day and by time, the page
// wearing the selected day's colour. See DESIGN.md "Schedule page".
//
// dynamic = "force-dynamic", for the same two reasons as the homepage:
//
//   1. /api/anime/schedule is a rolling 7-day window that changes as episodes
//      air, and go-api is not reachable at `next build`, so a prerender would
//      be an empty week served until the next revalidate.
//   2. A signed-in reader's own shows are marked on the page (and listed in
//      我追的 · 本周), read server-side with their cookie alongside the
//      schedule — never by a client island after hydration, which is what
//      broke signed-in state on the homepage three times. A visitor costs no
//      auth request in the browser at all.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/calendar">): Promise<Metadata> {
  const { locale, dict } = await resolveLocale(params);
  const title = dict.calendarPage.metaTitle;
  const description = dict.calendarPage.description;
  return {
    title,
    description,
    alternates: buildAlternates("/calendar", locale),
    openGraph: {
      title,
      description,
      url: "/calendar",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

/**
 * This request's render time — a helper rather than Date.now() in the
 * component body, which react-hooks/purity rejects. The board's clock starts
 * from it, so the server's "now" rule and the hydrated one agree.
 */
function requestTime(): number {
  return Date.now();
}

/** The season the server is in now (its own clock, like every season label on the site). */
function currentSeason() {
  return seasonOf(new Date(requestTime()));
}

export default async function CalendarPage({ params }: PageProps<"/[lang]/calendar">) {
  const season = currentSeason();
  const next = nextSeasonOf(season);

  const [{ dict, lang, locale }, schedule, watching, nextTotal] = await Promise.all([
    resolveLocale(params),
    fetchSchedule("CalendarPage"),
    fetchWatching(),
    fetchSeasonTotal(next),
  ]);

  const days = buildWeek(schedule, lang, {
    today: dict.home.today,
    todayShort: dict.schedule.todayShort,
    ep: dict.home.todayEp,
  });
  const weekTotal = days.reduce((n, d) => n + d.items.length, 0);
  const progress = watching.loggedOut
    ? null
    : Object.fromEntries(watching.items.map((w) => [w.anilistId, w.currentEpisode]));

  const nextSub = [
    nextTotal ? fillTemplate(dict.schedule.nextSeasonCount, { n: nextTotal }) : null,
    fillTemplate(dict.schedule.nextSeasonStart, { month: startMonthLabel(next.season, lang) }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ScheduleBoard
      days={days}
      serverNowMs={requestTime()}
      progress={progress}
      header={
        <ScheduleHeader
          heading={dict.calendarPage.heading}
          season={seasonYearLabel(season.season, season.year, lang)}
          title={dict.schedule.title}
          weekTotal={days.length > 0 ? fillTemplate(dict.schedule.weekTotal, { n: weekTotal }) : null}
        />
      }
      signIn={<SignInPrompt dict={dict} loginHref={authHrefWithFrom("/login", localizePath("/calendar", locale))} />}
      nextSeason={
        <NextSeasonLink
          href={seasonHref(next)}
          title={fillTemplate(dict.schedule.nextSeason, { season: seasonYearLabel(next.season, next.year, lang) })}
          sub={nextSub}
        />
      }
    />
  );
}
