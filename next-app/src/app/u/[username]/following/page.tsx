// /u/[username]/following — List of users that the profile user follows.
//
// Identical shape to /followers; the only differences are:
//   - endpoint: /api/users/{username}/following
//   - title:    dict.social.following
//   - canonical: /u/{username}/following

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { apiGet, apiGetPaged, ApiError } from "@/lib/api";
import { getDict, getLang } from "@/lib/i18n";
import { decodeUsername } from "@/lib/username";
import FollowListRow from "../_components/FollowListRow";
import type { FollowListItem } from "../_components/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ username: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface MeResponse {
  user?: { username: string } | null;
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

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username: usernameSlug } = await params;
  const username = decodeUsername(usernameSlug);
  const [lang, dict] = await Promise.all([getLang(), getDict()]);
  const title = `${dict.social.following} · ${username}`;
  const canonical = `/u/${encodeURIComponent(username)}/following`;
  return {
    title: { absolute: `${title} · AnimeGoClub` },
    description:
      lang === "zh"
        ? `查看 ${username} 关注的用户 — AnimeGoClub`
        : `Users that ${username} follows on AnimeGoClub`,
    alternates: {
      canonical,
      languages: {
        "zh-CN": canonical,
        "en-US": `${canonical}?lang=en`,
      },
    },
  };
}

const containerStyle: CSSProperties = { paddingTop: 40, paddingBottom: 60 };

const breadcrumbStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 28,
};

const backLinkStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
};

const separatorStyle: CSSProperties = {
  color: "rgba(84,84,88,0.65)",
};

const headingStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#ffffff",
  margin: 0,
};

const countBadgeStyle: CSSProperties = {
  marginLeft: 8,
  fontSize: 13,
  color: "#0a84ff",
  fontWeight: 600,
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxWidth: 480,
};

const emptyStyle: CSSProperties = {
  color: "rgba(235,235,245,0.30)",
  textAlign: "center",
  paddingTop: 40,
};

export default async function FollowingPage({ params, searchParams }: PageProps) {
  const { username: usernameSlug } = await params;
  const username = decodeUsername(usernameSlug);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const [dict, lang, me] = await Promise.all([getDict(), getLang(), fetchMe()]);

  let following: FollowListItem[] = [];
  let total = 0;
  let hasMore = false;
  let nextPage: number | null = null;
  let fetchError = false;

  try {
    const env = await apiGetPaged<FollowListItem>(
      `/api/users/${encodeURIComponent(username)}/following?page=${page}`,
      { cache: "no-store" },
    );
    following = env.data;
    total = env.total;
    hasMore = env.hasMore;
    nextPage = env.nextPage;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = true;
  }

  const viewerIsFollowing: boolean | null = me !== null ? false : null;

  return (
    <main className="container" style={containerStyle}>
      {/* Breadcrumb */}
      <nav aria-label={lang === "zh" ? "面包屑" : "Breadcrumb"} style={breadcrumbStyle}>
        <Link href={`/u/${encodeURIComponent(username)}`} style={backLinkStyle}>
          ← {username}
        </Link>
        <span style={separatorStyle} aria-hidden="true">
          /
        </span>
        <h1 style={headingStyle}>
          {dict.social.following}
          {total > 0 && <span style={countBadgeStyle}>{total}</span>}
        </h1>
      </nav>

      {fetchError && (
        <p style={emptyStyle}>{dict.social.userNotFound}</p>
      )}

      {!fetchError && following.length === 0 && (
        <p style={emptyStyle}>—</p>
      )}

      {!fetchError && following.length > 0 && (
        <div style={listStyle}>
          {following.map((u) => (
            <FollowListRow
              key={u.username}
              user={u}
              viewerIsFollowing={viewerIsFollowing}
              viewerUsername={me?.username ?? null}
              lang={lang}
            />
          ))}
        </div>
      )}

      {/* Pagination (simple prev/next) */}
      {!fetchError && total > 20 && (
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 24,
            maxWidth: 480,
          }}
        >
          {page > 1 && (
            <Link
              href={`/u/${encodeURIComponent(username)}/following?page=${page - 1}`}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                border: "1px solid rgba(84,84,88,0.65)",
                background: "transparent",
                color: "rgba(235,235,245,0.60)",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              {lang === "zh" ? "← 上一页" : "← Prev"}
            </Link>
          )}
          {hasMore && nextPage !== null && (
            <Link
              href={`/u/${encodeURIComponent(username)}/following?page=${nextPage}`}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                border: "1px solid rgba(84,84,88,0.65)",
                background: "transparent",
                color: "rgba(235,235,245,0.60)",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              {lang === "zh" ? "下一页 →" : "Next →"}
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
