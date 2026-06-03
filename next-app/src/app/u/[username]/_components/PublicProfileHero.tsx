"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import MemberPass from "@/components/profile/MemberPass";
import { memberNo as makeMemberNo, sinceLabel } from "@/components/profile/memberIdentity";
import { DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import "@/components/profile/cinematic.css";
import type { WatchingEntry } from "./types";

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
const STATUS_LABELS: Record<Lang, Record<string, string>> = {
  zh: { watching: "在看", completed: "看完", plan_to_watch: "想看", dropped: "抛弃" },
  en: { watching: "Watching", completed: "Completed", plan_to_watch: "Plan", dropped: "Dropped" },
};
const SEASON_LABELS: Record<Lang, Record<string, string>> = {
  zh: { WINTER: "冬季", SPRING: "春季", SUMMER: "夏季", FALL: "秋季" },
  en: { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" },
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
  const zh = lang === "zh";

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
    topSeason = zh ? `${year} ${SEASON_LABELS.zh[season] ?? ""}`.trim() : `${SEASON_LABELS.en[season] ?? ""} ${year}`.trim();
  }

  const chosen = watching.find((w) => w.anilistId === backdropAnilistId) ?? watching[0] ?? null;
  const backdrop = chosen?.bannerImageUrl ?? chosen?.coverImageUrl ?? DEFAULT_BACKDROP_IMAGE;
  const cardArt = chosen?.coverImageUrl ?? null;
  const memberNo = makeMemberNo(id);
  const total = watching.length;

  return (
    <div className="agc-cine-root">
      <div className="agc-cine-bg" aria-hidden="true">
        {backdrop && <div className="agc-cine-bg-img is-shown" style={{ backgroundImage: `url("${backdrop}")` }} />}
      </div>
      <div className="agc-cine-grain" aria-hidden="true" />

      <div className="agc-cine-content container">
        <section className="agc-hero" aria-label={zh ? "会员身份" : "Member identity"}>
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
              <Link href={`/u/${username}/followers`} style={{ color: "rgba(235,235,245,0.7)", fontSize: 14, textDecoration: "none" }}>
                <strong style={{ color: "#fff", fontWeight: 700 }}>{followerCount}</strong> {zh ? "粉丝" : "Followers"}
              </Link>
              <Link href={`/u/${username}/following`} style={{ color: "rgba(235,235,245,0.7)", fontSize: 14, textDecoration: "none" }}>
                <strong style={{ color: "#fff", fontWeight: 700 }}>{followingCount}</strong> {zh ? "关注" : "Following"}
              </Link>
            </div>

            {total > 0 && (
              <div className="agc-hero-reads">
                <Donut segments={segments} total={total} />
                <div className="agc-read-sep" />
                <div className="agc-read">
                  <b>{counts.completed}</b>
                  <span>{zh ? "看过 · 部" : "Watched"}</span>
                </div>
                {topSeason && (
                  <div className="agc-read season">
                    <b>{topSeason}</b>
                    <span>{zh ? "最活跃赛季" : "Top Season"}</span>
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
