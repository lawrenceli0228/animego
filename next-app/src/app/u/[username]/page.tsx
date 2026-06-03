// /u/[username] — Public user profile page.
//
// SSR with no ISR: profile data is personal and changes frequently
// (follow actions, new subscriptions). We do not cache this page.
//
// Auth strategy: SSR-fetch /api/auth/me to detect the viewer's identity.
// 401 = anon viewer. isFollowing from the profile endpoint is null when
// anon (backend OptionalAuth + *bool without omitempty).
//
// Architecture note: page.tsx is a Server Component. Interactive bits
// (FollowButton, WatchingSection expand/collapse, UserStatsPanel) are
// "use client" components under _components/. We pass server-fetched
// data down as props so there are no client-side loading states for the
// primary content — the page is fully rendered on first paint.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api";
import { getDict, getLang } from "@/lib/i18n";
import FollowButton from "./_components/FollowButton";
import WatchingSection from "./_components/WatchingSection";
import ShareButtonIsland from "./_components/ShareButtonIsland";
import PublicProfileHero from "./_components/PublicProfileHero";
import type { UserProfileData } from "./_components/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ username: string }>;
}

// ─── Data helpers ──────────────────────────────────────────────────────────

interface MeResponse {
  user?: { username: string; role?: string | null } | null;
}

async function fetchMe(): Promise<{ username: string } | null> {
  try {
    const data = await apiGet<MeResponse>("/api/auth/me", { cache: "no-store" });
    return data?.user ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    return null;
  }
}

async function fetchProfile(username: string): Promise<UserProfileData | null> {
  try {
    return await apiGet<UserProfileData>(`/api/users/${username}`, {
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// ─── generateMetadata ──────────────────────────────────────────────────────

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const [lang, dict] = await Promise.all([getLang(), getDict()]);
  // dict.profile.titleSuffix = "'s Watchlist" / "的追番"
  const suffix = dict.profile.titleSuffix;
  const title = `${username} ${suffix}`;
  const canonical = `/u/${username}`;

  return {
    title: { absolute: `${title} · AnimeGoClub` },
    description:
      lang === "zh"
        ? `${username} 的追番列表和社交主页 — AnimeGoClub`
        : `${username}'s watchlist and social profile on AnimeGoClub`,
    alternates: {
      canonical,
      languages: {
        "zh-CN": canonical,
        "en-US": `${canonical}?lang=en`,
      },
    },
    openGraph: {
      title,
      siteName: "AnimeGoClub",
      type: "profile",
      url: canonical,
    },
  };
}

// ShareButtonServer: thin wrapper; actual click handling is in ShareButtonIsland.

// ─── Page ─────────────────────────────────────────────────────────────────

export default async function UserProfilePage({ params }: PageProps) {
  const { username } = await params;

  const [dict, lang, profile, me] = await Promise.all([
    getDict(),
    getLang(),
    fetchProfile(username),
    fetchMe(),
  ]);

  if (!profile) notFound();

  const isSelf = me?.username === username;
  const isLoggedIn = me !== null;

  // When anon, isFollowing from the API is null — pass it straight through.
  // When the viewer is the owner, hide the button (isSelf=true on FollowButton).
  const initialIsFollowing: boolean | null = isLoggedIn
    ? (profile.isFollowing ?? false)
    : null;

  return (
    <main>
      <PublicProfileHero
        id={profile.id}
        username={username}
        createdAt={profile.createdAt}
        avatarUrl={profile.avatarUrl}
        backdropAnilistId={profile.backdropAnilistId}
        followerCount={profile.followerCount}
        followingCount={profile.followingCount}
        watching={profile.watching}
        lang={lang}
        actions={
          <>
            <ShareButtonIsland
              username={username}
              shareLabel={dict.social.share}
              copiedLabel={dict.detail.linkCopied}
              copyFailedLabel={dict.detail.linkCopyFailed}
            />
            <FollowButton
              username={username}
              initialIsFollowing={initialIsFollowing}
              isSelf={isSelf}
              lang={lang}
            />
          </>
        }
      >
        <div style={{ paddingTop: 8, paddingBottom: 60 }}>
          <WatchingSection watching={profile.watching} lang={lang} />
        </div>
      </PublicProfileHero>
    </main>
  );
}
