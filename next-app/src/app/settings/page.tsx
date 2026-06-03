import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api";
import { getLang } from "@/lib/i18n";
import { pickTitle } from "@/lib/formatters";
import SettingsClient from "./_components/SettingsClient";
import type { SubscriptionListItem } from "../profile/_components/types";
import type { BackdropOption } from "@/components/profile/backdropTypes";

// Auth-gated standard settings page: account (username), security (password),
// and member-pass personalization (photo + backdrop). SSR-fetches the user +
// their list so the backdrop picker and live preview render on first paint.
export const dynamic = "force-dynamic";

interface MeResp {
  user?: {
    id?: string | null;
    username: string;
    createdAt?: string | null;
    avatarUrl?: string | null;
    backdropAnilistId?: number | null;
  } | null;
}

async function fetchMe(): Promise<NonNullable<MeResp["user"]> | null> {
  try {
    const d = await apiGet<MeResp>("/api/auth/me", { cache: "no-store" });
    return d?.user ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    return null;
  }
}

async function fetchSubs(): Promise<SubscriptionListItem[]> {
  try {
    return (await apiGet<SubscriptionListItem[]>("/api/subscriptions", { cache: "no-store" })) ?? [];
  } catch {
    return [];
  }
}

export const metadata: Metadata = {
  title: { absolute: "用户设置 — AnimeGoClub" },
  robots: { index: false, follow: false },
  alternates: { canonical: "/settings" },
};

const SEASON_ZH: Record<string, string> = {
  WINTER: "冬季",
  SPRING: "春季",
  SUMMER: "夏季",
  FALL: "秋季",
};

export default async function SettingsPage() {
  const [lang, me, subs] = await Promise.all([getLang(), fetchMe(), fetchSubs()]);
  if (!me?.username) redirect("/login?next=/settings");

  // backdrop options (cover + banner) + completed count + top season
  const seen = new Set<number>();
  const backdropOptions: BackdropOption[] = [];
  let watchedCount = 0;
  const seasonCounts: Record<string, number> = {};
  for (const it of subs) {
    if (it.status === "completed") watchedCount += 1;
    if (it.season && it.seasonYear) {
      const k = `${it.seasonYear}-${it.season}`;
      seasonCounts[k] = (seasonCounts[k] ?? 0) + 1;
    }
    if (it.coverImageUrl && !seen.has(it.anilistId)) {
      seen.add(it.anilistId);
      backdropOptions.push({
        anilistId: it.anilistId,
        title: pickTitle(it, lang),
        coverUrl: it.coverImageUrl,
        bannerUrl: it.bannerImageUrl ?? null,
      });
    }
  }
  const topEntry = Object.entries(seasonCounts).sort((a, b) => b[1] - a[1])[0];
  let topSeason: string | null = null;
  if (topEntry) {
    const [year, season] = topEntry[0].split("-");
    topSeason =
      lang === "zh"
        ? `${year} ${SEASON_ZH[season] ?? ""}`.trim()
        : `${season} ${year}`;
  }

  return (
    <main>
      <SettingsClient
        username={me.username}
        userId={me.id ?? null}
        createdAt={me.createdAt ?? null}
        avatarUrl={me.avatarUrl ?? null}
        backdropAnilistId={me.backdropAnilistId ?? null}
        backdropOptions={backdropOptions.slice(0, 80)}
        watchedCount={watchedCount}
        topSeason={topSeason}
        lang={lang}
      />
    </main>
  );
}
