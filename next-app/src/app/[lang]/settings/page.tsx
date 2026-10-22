import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import { pickTitle } from "@/lib/formatters";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import SettingsClient from "./_components/SettingsClient";
import {
  SESSIONS_FAILED,
  readSessions,
  toDeviceSessions,
  type SessionsLoad,
} from "./_components/deviceSessions";
import type { SubscriptionListItem } from "../profile/_components/types";
import type { BackdropOption } from "@/components/profile/backdropTypes";
import { sinceLabel } from "@/components/profile/memberIdentity";
import { seasonYearLabel } from "@/lib/contentLabels";

// Auth-gated settings page: the member pass (photo + backdrop), the account
// (username, password link), signed-in devices, privacy, playback. SSR-fetches
// the user, their list and their sessions so every section renders on first
// paint.
export const dynamic = "force-dynamic";

interface MeResp {
  user?: {
    id?: string | null;
    username: string;
    /** True when `username` is a masked handle rather than a chosen name. */
    usernameHidden?: boolean;
    email?: string | null;
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

async function fetchSessions(): Promise<SessionsLoad> {
  try {
    return readSessions(await apiGet<unknown>("/api/auth/sessions", { cache: "no-store" }));
  } catch {
    // 5xx, a timeout, or 401 — go-api's answer when this device's own refresh
    // session is not live, which /me (on the 15-minute access token) can
    // outlast. The section says 加载失败; nothing else on the page needs it.
    return SESSIONS_FAILED;
  }
}

/**
 * This request's render time — a helper rather than Date.now() in the
 * component body, which react-hooks/purity rejects. The devices' "2 小时前"
 * is measured from it on the server and again after hydration, so the two
 * renders agree.
 */
function requestTime(): number {
  return Date.now();
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
  const [{ locale, lang }, me, subs, sessions] = await Promise.all([
    resolveLocale(params),
    fetchMe(),
    fetchSubs(),
    fetchSessions(),
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
        email={me.email ?? ""}
        // Here and not in the client: it reads the clock's own time zone,
        // which is the server's here and the reader's in a browser.
        since={sinceLabel(me.createdAt)}
        avatarUrl={me.avatarUrl ?? null}
        backdropAnilistId={me.backdropAnilistId ?? null}
        backdropOptions={backdropOptions.slice(0, 80)}
        watchedCount={watchedCount}
        topSeason={topSeason}
        isPublic={me.isPublic ?? true}
        // Places are resolved to words here, once: Intl.DisplayNames does not
        // name countries the same way in Node and in WebKit (deviceLabels.ts).
        sessions={toDeviceSessions(sessions.items, lang)}
        sessionsFailed={sessions.failed}
        serverNowMs={requestTime()}
      />
    </main>
  );
}
