import type { Metadata } from "next";
import { apiGet, ApiError } from "@/lib/api";
import { resolveLocale } from "@/lib/i18n/route";
import type { Dict, Lang } from "@/lib/i18n";
import { buildAlternates } from "@/lib/seo/alternates";
import ProfileClient from "./_components/ProfileClient";
import type { SubscriptionListItem } from "./_components/types";

// This page is auth-gated by middleware (orchestrator adds /profile to the
// gate). The SSR fetch below will 401 when the session cookie is absent,
// which gracefully falls back to an empty list.
export const dynamic = "force-dynamic";

// ─── SSR helpers ─────────────────────────────────────────────────────────────

interface MeResponse {
  user?: {
    id?: string | null;
    username: string;
    role?: string | null;
    createdAt?: string | null;
    avatarUrl?: string | null;
    backdropAnilistId?: number | null;
    backdropBannerUrl?: string | null;
    backdropCoverUrl?: string | null;
  } | null;
}

export interface ProfileIdentity {
  username: string;
  userId: string | null;
  createdAt: string | null;
  avatarUrl: string | null;
  backdropAnilistId: number | null;
  backdropBannerUrl: string | null;
  backdropCoverUrl: string | null;
}

async function safeMe(): Promise<ProfileIdentity | null> {
  try {
    const data = await apiGet<MeResponse>("/api/auth/me", { cache: "no-store" });
    const u = data?.user;
    if (!u?.username) return null;
    return {
      username: u.username,
      userId: u.id ?? null,
      createdAt: u.createdAt ?? null,
      avatarUrl: u.avatarUrl ?? null,
      backdropAnilistId: u.backdropAnilistId ?? null,
      backdropBannerUrl: u.backdropBannerUrl ?? null,
      backdropCoverUrl: u.backdropCoverUrl ?? null,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    console.warn("[ProfilePage] /api/auth/me fetch failed:", err);
    return null;
  }
}

async function safeSubscriptions(
  status?: string,
): Promise<SubscriptionListItem[]> {
  try {
    const url = status
      ? `/api/subscriptions?status=${status}`
      : "/api/subscriptions";
    const items = await apiGet<SubscriptionListItem[]>(url, {
      cache: "no-store",
    });
    return items ?? [];
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return [];
    console.warn("[ProfilePage] subscriptions fetch failed:", err);
    return [];
  }
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

// A local Record rather than dictionary keys because the description is
// DERIVED — the Chinese one composes two other dictionary values, so a flat
// key would be a third copy of the site description that drifts from
// meta.description the first time that is edited. The English branch has no
// such composition, which is exactly why `lang === "zh" ? … : …` could not
// express this without handing every future language the English sentence.
const PAGE_META: Record<Lang, { title: string; description: (dict: Dict) => string }> = {
  zh: {
    title: "我的追番 — AnimeGoClub",
    description: (dict) => `${dict.profile.label} — ${dict.meta.description}`,
  },
  en: {
    title: "My Watchlist — AnimeGoClub",
    description: () => "Your personal watchlist on AnimeGoClub.",
  },
  "zh-Hant": {
    title: "我的追番 — AnimeGoClub",
    description: (dict) => `${dict.profile.label} — ${dict.meta.description}`,
  },
};

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/profile">): Promise<Metadata> {
  const { locale, dict, lang } = await resolveLocale(params);
  const title = PAGE_META[lang].title;
  const description = PAGE_META[lang].description(dict);

  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    alternates: buildAlternates("/profile", locale),
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ProfilePage({
  params,
}: PageProps<"/[lang]/profile">) {
  // Parallel fetches: user identity + initial "watching" tab + all subs for stats.
  // SSR the default tab (watching) for fast first paint.
  const [{ dict, lang }, identity, initialItems, allSubsInitial] =
    await Promise.all([
      resolveLocale(params),
      safeMe(),
      safeSubscriptions("watching"),
      safeSubscriptions(), // no filter = all statuses (stats panel)
    ]);

  return (
    <main>
      <ProfileClient
        username={identity?.username ?? null}
        userId={identity?.userId ?? null}
        createdAt={identity?.createdAt ?? null}
        avatarUrl={identity?.avatarUrl ?? null}
        backdropAnilistId={identity?.backdropAnilistId ?? null}
        backdropBannerUrl={identity?.backdropBannerUrl ?? null}
        backdropCoverUrl={identity?.backdropCoverUrl ?? null}
        initialItems={initialItems}
        allSubsInitial={allSubsInitial}
        dict={dict}
        lang={lang}
      />
    </main>
  );
}
