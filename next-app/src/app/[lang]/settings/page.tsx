import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import { pickTitle } from "@/lib/formatters";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import SettingsClient from "./_components/SettingsClient";
import type { SubscriptionListItem } from "../profile/_components/types";
import type { BackdropOption } from "@/components/profile/backdropTypes";
import { seasonYearLabel } from "@/lib/contentLabels";

// Auth-gated standard settings page: account (username), security (password),
// and member-pass personalization (photo + backdrop). SSR-fetches the user +
// their list so the backdrop picker and live preview render on first paint.
export const dynamic = "force-dynamic";

interface MeResp {
  user?: {
    id?: string | null;
    username: string;
    /** True when `username` is a masked handle rather than a chosen name. */
    usernameHidden?: boolean;
    createdAt?: string | null;
    avatarUrl?: string | null;
    backdropAnilistId?: number | null;
    isPublic?: boolean;
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

// generateMetadata rather than a static `metadata` object: the canonical
// has to name the locale the visitor is actually in, and only the route
// param knows that. The title stays hardcoded Chinese — this page is
// noindex, and inventing an English string for it here would be worse than
// leaving the gap visible for the dictionary work to close.
export async function generateMetadata({
  params,
}: PageProps<"/[lang]/settings">): Promise<Metadata> {
  const { locale } = await resolveLocale(params);
  return {
    title: { absolute: "用户设置 — AnimeGoClub" },
    robots: { index: false, follow: false },
    alternates: buildAlternates("/settings", locale),
  };
}

export default async function SettingsPage({
  params,
}: PageProps<"/[lang]/settings">) {
  const [{ locale, lang }, me, subs] = await Promise.all([
    resolveLocale(params),
    fetchMe(),
    fetchSubs(),
  ]);
  // `from`, not `next`: /login reads ?from= (sanitizeFromParam) and has
  // never looked at ?next=. The old param was therefore inert — every
  // session-expired hit on /settings silently became a trip to the home
  // page after re-auth.
  if (!me?.username) redirect(authHrefWithFrom("/login", localizePath("/settings", locale)));

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
    topSeason = seasonYearLabel(season, year, lang);
  }

  return (
    <main>
      <SettingsClient
        username={me.username}
        usernameHidden={me.usernameHidden ?? false}
        userId={me.id ?? null}
        createdAt={me.createdAt ?? null}
        avatarUrl={me.avatarUrl ?? null}
        backdropAnilistId={me.backdropAnilistId ?? null}
        backdropOptions={backdropOptions.slice(0, 80)}
        watchedCount={watchedCount}
        topSeason={topSeason}
        isPublic={me.isPublic ?? true}
      />
    </main>
  );
}
