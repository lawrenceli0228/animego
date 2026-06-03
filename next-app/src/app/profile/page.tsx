import type { Metadata } from "next";
import { apiGet, ApiError } from "@/lib/api";
import { getDict, getLang } from "@/lib/i18n";
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
  } | null;
}

export interface ProfileIdentity {
  username: string;
  userId: string | null;
  createdAt: string | null;
  avatarUrl: string | null;
  backdropAnilistId: number | null;
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

export async function generateMetadata(): Promise<Metadata> {
  const [dict, lang] = await Promise.all([getDict(), getLang()]);
  const title =
    lang === "zh" ? "我的追番 — AnimeGoClub" : "My Watchlist — AnimeGoClub";
  const description =
    lang === "zh"
      ? `${dict.profile.label} — ${dict.meta.description}`
      : `Your personal watchlist on AnimeGoClub.`;

  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    alternates: {
      canonical: "/profile",
    },
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ProfilePage() {
  // Parallel fetches: user identity + initial "watching" tab + all subs for stats.
  // SSR the default tab (watching) for fast first paint.
  const [dict, lang, identity, initialItems, allSubsInitial] =
    await Promise.all([
      getDict(),
      getLang(),
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
        initialItems={initialItems}
        allSubsInitial={allSubsInitial}
        dict={dict}
        lang={lang}
      />
    </main>
  );
}
