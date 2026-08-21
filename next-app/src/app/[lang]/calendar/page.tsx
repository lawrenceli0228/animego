import type { Metadata } from "next";
import WeeklySchedule, {
  type ScheduleResponse,
} from "@/components/anime/WeeklySchedule";
import { apiGet } from "@/lib/api";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import type { CSSProperties } from "react";

// Rolling 7-day schedule changes continuously as episodes air and
// Mongo rotates the window. Force no-store so every render reflects the
// live data, matching the legacy SPA's React Query default.
export const dynamic = "force-dynamic";

const EMPTY_SCHEDULE: ScheduleResponse = { today: "", groups: {} };

async function safeSchedule(): Promise<ScheduleResponse> {
  try {
    return await apiGet<ScheduleResponse>("/api/anime/schedule", {
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[CalendarPage] schedule fetch failed:", err);
    return EMPTY_SCHEDULE;
  }
}

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

const pageStyle: CSSProperties = { paddingTop: 40, paddingBottom: 60 };

const headerStyle: CSSProperties = { marginBottom: 24 };

const h1Style: CSSProperties = {
  fontSize: "clamp(22px,3vw,34px)",
  color: "#ffffff",
  marginBottom: 12,
};

const subStyle: CSSProperties = {
  color: "rgba(235,235,245,0.60)",
  fontSize: 15,
  lineHeight: 1.6,
  maxWidth: 640,
};

export default async function CalendarPage({
  params,
}: PageProps<"/[lang]/calendar">) {
  const [{ dict, lang }, schedule] = await Promise.all([
    resolveLocale(params),
    safeSchedule(),
  ]);

  const heading = dict.calendarPage.heading;
  const sub = dict.calendarPage.description;

  return (
    <main>
      <div className="container" style={pageStyle}>
        <header style={headerStyle}>
          <h1 style={h1Style}>{heading}</h1>
          <p style={subStyle}>{sub}</p>
        </header>

        <WeeklySchedule schedule={schedule} dict={dict} lang={lang} />
      </div>
    </main>
  );
}
