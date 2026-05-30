import type { Metadata } from "next";
import WeeklySchedule, {
  type ScheduleResponse,
} from "@/components/anime/WeeklySchedule";
import { apiGet } from "@/lib/api";
import { getDict, getLang } from "@/lib/i18n";
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

export async function generateMetadata(): Promise<Metadata> {
  const [dict, lang] = await Promise.all([getDict(), getLang()]);
  const title =
    lang === "zh" ? "今日新番放送日历 — AnimeGo" : "Airing Calendar — AnimeGo";
  const description =
    lang === "zh"
      ? "本周新番放送时间表，按周一至周日分组，覆盖连载中的 TV 动画与 ONA。每日更新。"
      : "Weekly anime airing schedule grouped by day. Updated daily.";
  // Suppress TS unused warning — dict is fetched for structural symmetry
  // with other pages; description is derived from lang directly above.
  void dict;
  return {
    title,
    description,
    alternates: {
      canonical: "/calendar",
      languages: {
        "zh-CN": "/calendar",
        "en-US": "/calendar?lang=en",
      },
    },
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

export default async function CalendarPage() {
  const [dict, lang, schedule] = await Promise.all([
    getDict(),
    getLang(),
    safeSchedule(),
  ]);

  const heading =
    lang === "zh" ? "今日新番放送日历" : "Today's Airing Calendar";
  const sub =
    lang === "zh"
      ? "本周新番放送时间表，按周一至周日分组，覆盖连载中的 TV 动画与 ONA。每日更新。"
      : "Weekly anime airing schedule grouped by day. Updated daily.";

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
