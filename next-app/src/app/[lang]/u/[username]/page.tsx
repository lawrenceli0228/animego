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
import { notFound, permanentRedirect } from "next/navigation";
import { apiGet, ApiError } from "@/lib/api";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import { decodeUsername } from "@/lib/username";
import { canonicalHandle, encodePathSegment } from "./_lib/canonicalHandle";
import FollowButton from "./_components/FollowButton";
import WatchingSection from "./_components/WatchingSection";
import ShareButtonIsland from "./_components/ShareButtonIsland";
import PublicProfileHero from "./_components/PublicProfileHero";
import PrivateProfileState from "./_components/PrivateProfileState";
import ProfileSafetyActions from "./_components/ProfileSafetyActions";
import type { UserProfileData } from "./_components/types";

export const dynamic = "force-dynamic";

type UserProfilePageProps = PageProps<"/[lang]/u/[username]">;

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
    // encodePathSegment, not encodeURIComponent: the latter over-encodes '@'
    // and the Go router matches the literal, so a contact-shaped handle would
    // 404 here and the redirect below would never be reached.
    return await apiGet<UserProfileData>(`/api/users/${encodePathSegment(username)}`, {
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// ─── generateMetadata ──────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: UserProfilePageProps): Promise<Metadata> {
  const { username: usernameSlug } = await params;
  const requested = decodeUsername(usernameSlug);

  // This function — not the page body — is where a contact-shaped handle was
  // reaching the response. It never consulted the API, so the raw param went
  // straight into the title, the description, the canonical, and the og /
  // twitter tags. The page component could not prevent it: metadata is built
  // independently, and for these handles the profile fetch 404s anyway, so
  // the body was already the not-found state while the head still carried the
  // address.
  //
  // Resolve first. Unknown handles fall back to a neutral title rather than
  // echoing whatever string was in the URL — that echo is the whole leak.
  const [{ locale, lang, dict }, resolved] = await Promise.all([
    resolveLocale(params),
    canonicalHandle(requested),
  ]);
  const username = resolved ?? "";

  if (!username) {
    // No such user. Say nothing identifying, and do not offer a canonical
    // for a URL that resolves to a not-found page.
    return { title: { absolute: "AnimeGoClub" }, robots: { index: false, follow: false } };
  }

  // After the guard, so `canonical` is a string rather than a
  // `string | undefined` that the old language map interpolated into
  // "undefined?lang=en" on the branch that could not be reached.
  const title = `${username} ${dict.profile.titleSuffix}`;
  const canonical = `/u/${encodeURIComponent(username)}`;

  // The visitor asked for this profile by a handle that is not the one it
  // should be addressed by — in practice, the stored contact-shaped username
  // rather than the masked handle. The page component redirects, but that
  // redirect cannot set a status code: the root loading.tsx puts every route
  // behind a Suspense boundary, so the shell has already flushed by the time
  // the component runs and Next falls back to a client-side navigation.
  //
  // So the status stays 200 for a crawler, and without this the URL would be
  // indexable — with clean content, but with the address in the URL itself.
  // noindex keeps it out, and the canonical below still points at the handle
  // form so any existing index entry consolidates there.
  const addressedByAlias = username !== requested;

  return {
    title: { absolute: `${title} · AnimeGoClub` },
    description:
      lang === "zh"
        ? `${username} 的追番列表和社交主页 — AnimeGoClub`
        : `${username}'s watchlist and social profile on AnimeGoClub`,
    ...(addressedByAlias ? { robots: { index: false, follow: false } } : {}),
    alternates: buildAlternates(canonical, locale),
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

export default async function UserProfilePage({ params }: UserProfilePageProps) {
  const { username: usernameSlug } = await params;
  const username = decodeUsername(usernameSlug);

  const [{ dict, lang }, profile, me] = await Promise.all([
    resolveLocale(params),
    fetchProfile(username),
    fetchMe(),
  ]);

  if (!profile) notFound();

  // The API answers to both the stored username and the masked handle, but
  // only the handle may appear on screen or in a URL. When a contact-shaped
  // username is what reached us, this route was rendering it into the title,
  // the canonical and the body — the one surface the serialization masking in
  // go-api/internal/pii could not reach, because it renders the path param
  // rather than the response.
  //
  // Permanent, not temporary: the address form of this URL should leave the
  // index rather than be kept alive as an alternate.
  if (profile.username !== username) {
    permanentRedirect(`/u/${encodeURIComponent(profile.username)}`);
  }

  const isSelf = me?.username === username;
  const isLoggedIn = me !== null;

  // When anon, isFollowing from the API is null — pass it straight through.
  // When the viewer is the owner, hide the button (isSelf=true on FollowButton).
  const initialIsFollowing: boolean | null = isLoggedIn
    ? (profile.isFollowing ?? false)
    : null;
  const isPrivate = profile.isPrivate === true || profile.isPublic === false;
  const isBlocked = profile.isBlocked === true;
  const watching = Array.isArray(profile.watching) ? profile.watching : [];

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
        watching={watching}
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
              isSelf={isSelf || isBlocked}
              lang={lang}
            />
            <ProfileSafetyActions
              username={username}
              authenticated={isLoggedIn}
              isSelf={isSelf}
              isBlocked={isBlocked}
              blockedByViewer={profile.blockedByViewer === true}
            />
          </>
        }
      >
        <div style={{ paddingTop: 8, paddingBottom: 60 }}>
          {isPrivate ? <PrivateProfileState blocked={isBlocked} /> : <WatchingSection watching={watching} />}
        </div>
      </PublicProfileHero>
    </main>
  );
}
