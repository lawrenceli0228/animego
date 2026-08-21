"use client";

import type { ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import type { Lang } from "@/lib/i18n";
import MemberPass from "@/components/profile/MemberPass";
import {
  HERO_ARIA,
  TOP_SEASON_LABEL,
  WATCHED_LABEL,
} from "@/components/profile/passLabels";
import { memberNo as makeMemberNo, sinceLabel } from "@/components/profile/memberIdentity";
import { DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import { cssUrl } from "@/lib/cssUrl";
import "@/components/profile/cinematic.css";
import type { WatchingEntry } from "./types";
import { seasonYearLabel } from "@/lib/contentLabels";

// PublicProfileHero — cinematic member-pass head for the public /u/[username]
// page. Reads the owner's DB-persisted photo + backdrop so visitors see the
// same pass the owner set. Renders the follow/share actions + follower counts.

const STATUS_ORDER = ["watching", "completed", "plan_to_watch", "dropped"] as const;
const STATUS_COLORS: Record<string, string> = {
  watching: "#0a84ff",
  completed: "#30d158",
  plan_to_watch: "#5ac8fa",
  dropped: "#ff453a",
};
// The two follower counters. Local Records rather than dict.social.followers
// — this component takes `lang`, not `dict`; its dictionary-owned strings
// (follow/share) are rendered by the page and handed in via `actions`. Keep
// the wording in step with social.followers / social.following by hand.
const FOLLOWERS_LABEL: Record<Lang, string> = {
  zh: "粉丝",
  en: "Followers",
  "zh-Hant": "粉絲",
};

const FOLLOWING_LABEL: Record<Lang, string> = {
  zh: "关注",
  en: "Following",
  "zh-Hant": "關注",
};

const STATUS_LABELS: Record<Lang, Record<string, string>> = {
  zh: { watching: "在看", completed: "看完", plan_to_watch: "想看", dropped: "抛弃" },
  en: { watching: "Watching", completed: "Completed", plan_to_watch: "Plan", dropped: "Dropped" },
  "zh-Hant": { watching: "在看", completed: "看完", plan_to_watch: "想看", dropped: "拋棄" },
};

interface PublicProfileHeroProps {
  id: string;
  username: string;
  createdAt: string | null;
  avatarUrl: string | null;
  backdropAnilistId: number | null;
  followerCount: number;
  followingCount: number;
  watching: WatchingEntry[];
  /** Follow + share buttons rendered by the page (own the dict labels). */
  actions: ReactNode;
  lang: Lang;
  children?: ReactNode;
}

function Donut({ segments, total }: { segments: { value: number; color: string }[]; total: number }) {
  const size = 92;
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  let offset = 0;
  if (!total) return null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={9} />
      {segments.filter((s) => s.value > 0).map((seg, i) => {
        const dash = c * (seg.value / total);
        const cur = offset;
        offset += dash;
        return (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={seg.color} strokeWidth={9}
            strokeLinecap="round" strokeDasharray={`${Math.max(dash - 2, 0)} ${c}`} strokeDashoffset={-cur}
            style={{ transform: "rotate(-90deg)", transformOrigin: "center" }} />
        );
      })}
      <text x={size / 2} y={size / 2 + 7} textAnchor="middle" fill="#fff"
        style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-display), sans-serif" }}>
        {total}
      </text>
    </svg>
  );
}

export default function PublicProfileHero({
  id,
  username,
  createdAt,
  avatarUrl,
  backdropAnilistId,
  followerCount,
  followingCount,
  watching,
  actions,
  lang,
  children,
}: PublicProfileHeroProps) {

  const counts: Record<string, number> = { watching: 0, completed: 0, plan_to_watch: 0, dropped: 0 };
  const seasonCounts: Record<string, number> = {};
  for (const w of watching) {
    if (w.subscriptionStatus in counts) counts[w.subscriptionStatus] += 1;
    if (w.season && w.seasonYear) {
      const k = `${w.seasonYear}-${w.season}`;
      seasonCounts[k] = (seasonCounts[k] ?? 0) + 1;
    }
  }
  const live = STATUS_ORDER.filter((s) => counts[s] > 0);
  const segments = live.map((s) => ({ value: counts[s], color: STATUS_COLORS[s] }));
  const legend = live.map((s) => ({ label: STATUS_LABELS[lang][s], count: counts[s], color: STATUS_COLORS[s] }));
  const topEntry = Object.entries(seasonCounts).sort((a, b) => b[1] - a[1])[0];
  let topSeason: string | null = null;
  if (topEntry) {
    const [year, season] = topEntry[0].split("-");
    topSeason = seasonYearLabel(season, year, lang);
  }

  // A chosen backdrop that isn't in the (capped) watching list falls through to
  // the default — never to a random first anime. The first entry auto-fills only
  // when no backdrop is chosen.
  const chosen = watching.find((w) => w.anilistId === backdropAnilistId) ?? null;
  const pick = chosen ?? (backdropAnilistId == null ? (watching[0] ?? null) : null);
  const backdrop = pick?.bannerImageUrl ?? pick?.coverImageUrl ?? DEFAULT_BACKDROP_IMAGE;
  const cardArt = pick?.coverImageUrl ?? null;
  const memberNo = makeMemberNo(id);
  const total = watching.length;

  return (
    <div className="agc-cine-root">
      <div className="agc-cine-bg" aria-hidden="true">
        {backdrop && <div className="agc-cine-bg-img is-shown" style={{ backgroundImage: cssUrl(backdrop, DEFAULT_BACKDROP_IMAGE) }} />}
      </div>
      <div className="agc-cine-grain" aria-hidden="true" />

      <div className="agc-cine-content container">
        <section className="agc-hero" aria-label={HERO_ARIA[lang]}>
          <MemberPass
            username={username}
            memberNo={memberNo}
            since={sinceLabel(createdAt)}
            watchedCount={counts.completed}
            topSeason={topSeason}
            artUrl={cardArt}
            photoUrl={avatarUrl}
            lang={lang}
          />

          <div className="agc-hero-ident">
            <p className="agc-hero-kicker">{`#${memberNo}`}</p>
            <h1 className="agc-hero-name">{username}</h1>

            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
              <Link href={`/u/${encodeURIComponent(username)}/followers`} style={{ color: "rgba(235,235,245,0.7)", fontSize: 14, textDecoration: "none" }}>
                <strong style={{ color: "#fff", fontWeight: 700 }}>{followerCount}</strong> {FOLLOWERS_LABEL[lang]}
              </Link>
              <Link href={`/u/${encodeURIComponent(username)}/following`} style={{ color: "rgba(235,235,245,0.7)", fontSize: 14, textDecoration: "none" }}>
                <strong style={{ color: "#fff", fontWeight: 700 }}>{followingCount}</strong> {FOLLOWING_LABEL[lang]}
              </Link>
            </div>

            {total > 0 && (
              <div className="agc-hero-reads">
                <Donut segments={segments} total={total} />
                <div className="agc-read-sep" />
                <div className="agc-read">
                  <b>{counts.completed}</b>
                  <span>{WATCHED_LABEL[lang]}</span>
                </div>
                {topSeason && (
                  <div className="agc-read season">
                    <b>{topSeason}</b>
                    <span>{TOP_SEASON_LABEL[lang]}</span>
                  </div>
                )}
              </div>
            )}

            {legend.length > 0 && (
              <div className="agc-hero-legend">
                {legend.map((l) => (
                  <span className="agc-legend-item" key={l.label}>
                    <i style={{ background: l.color }} />
                    {l.label}
                    <b>{l.count}</b>
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>{actions}</div>
          </div>
        </section>

        {children}
      </div>
    </div>
  );
}
