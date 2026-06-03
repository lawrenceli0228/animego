"use client";

import type { Lang } from "@/lib/i18n";
import MemberPass from "./MemberPass";
import type { BackdropOption } from "./backdropTypes";
import { DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import { cssUrl } from "@/lib/cssUrl";
import "./cinematic.css";

// ProfileHero — the cinematic identity head of /profile. The member pass is
// the hero; behind it the chosen anime's wide banner fills the page. The two
// personalisation choices (photo + backdrop) are edited on /settings and
// persisted to the DB; they arrive here as server-sourced props (avatarUrl +
// backdropAnilistId) so the page reflects them on load and after a save.

interface DonutSegment {
  value: number;
  color: string;
}

interface ProfileHeroProps {
  username: string;
  memberNo: string;
  since: string;
  /** Donut center number = all subscriptions. */
  totalCount: number;
  segments: DonutSegment[];
  /** Legend rows in display order. */
  legend: { label: string; count: number; color: string }[];
  /** 看过 · 部 (completed count). */
  watchedCount: number;
  topSeason: string | null;
  /** Covers + banners from the user's list, to resolve the chosen backdrop. */
  backdropOptions: BackdropOption[];
  /** DB-persisted pass photo (card face + avatar); null → cover. */
  avatarUrl: string | null;
  /** DB-persisted chosen backdrop anime; null → first list item. */
  backdropAnilistId: number | null;
  lang: Lang;
  /** Page content (tabs / search / list) rendered over the same atmosphere. */
  children?: React.ReactNode;
}

function CompactDonut({
  segments,
  total,
}: {
  segments: DonutSegment[];
  total: number;
}) {
  const size = 92;
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  let offset = 0;
  if (!total) return null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={9} />
      {segments
        .filter((seg) => seg.value > 0)
        .map((seg, i) => {
          const pct = seg.value / total;
          const dash = c * pct;
          const cur = offset;
          offset += dash;
          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={9}
              strokeLinecap="round"
              strokeDasharray={`${Math.max(dash - 2, 0)} ${c}`}
              strokeDashoffset={-cur}
              style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
            />
          );
        })}
      <text
        x={size / 2}
        y={size / 2 + 7}
        textAnchor="middle"
        fill="#fff"
        style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-display), sans-serif" }}
      >
        {total}
      </text>
    </svg>
  );
}

export default function ProfileHero({
  username,
  memberNo,
  since,
  totalCount,
  segments,
  legend,
  watchedCount,
  topSeason,
  backdropOptions,
  avatarUrl,
  backdropAnilistId,
  lang,
  children,
}: ProfileHeroProps) {
  const photoUrl = avatarUrl;

  const chosen =
    backdropOptions.find((o) => o.anilistId === backdropAnilistId) ??
    backdropOptions[0] ??
    null;
  // Backdrop prefers the wide banner; cover, then the default, fill in when
  // the user hasn't chosen a backdrop with one.
  const backdrop = chosen?.bannerUrl ?? chosen?.coverUrl ?? DEFAULT_BACKDROP_IMAGE;
  const cardArt = chosen?.coverUrl ?? null;

  return (
    <div className="agc-cine-root">
      <div className="agc-cine-bg" aria-hidden="true">
        {backdrop && (
          <div
            className="agc-cine-bg-img is-shown"
            style={{ backgroundImage: cssUrl(backdrop, DEFAULT_BACKDROP_IMAGE) }}
          />
        )}
      </div>
      <div className="agc-cine-grain" aria-hidden="true" />

      <div className="agc-cine-content container">
        <section className="agc-hero" aria-label={lang === "zh" ? "会员身份" : "Member identity"}>
          <MemberPass
            username={username}
            memberNo={memberNo}
            since={since}
            watchedCount={watchedCount}
            topSeason={topSeason}
            artUrl={cardArt}
            photoUrl={photoUrl}
            lang={lang}
          />

          <div className="agc-hero-ident">
            <p className="agc-hero-kicker">
              {lang === "zh" ? "我的会员通行证" : "My Member Pass"}
            </p>
            <h1 className="agc-hero-name">
              {username}
              <span className="suffix">{lang === "zh" ? " 的追番" : "'s list"}</span>
            </h1>

            <div className="agc-hero-reads">
              <CompactDonut segments={segments} total={totalCount} />
              <div className="agc-read-sep" />
              <div className="agc-read">
                <b>{watchedCount}</b>
                <span>{lang === "zh" ? "看过 · 部" : "Watched"}</span>
              </div>
              {topSeason && (
                <div className="agc-read season">
                  <b>{topSeason}</b>
                  <span>{lang === "zh" ? "最活跃赛季" : "Top Season"}</span>
                </div>
              )}
            </div>

            <div className="agc-hero-legend">
              {legend.map((l) => (
                <span className="agc-legend-item" key={l.label}>
                  <i style={{ background: l.color }} />
                  {l.label}
                  <b>{l.count}</b>
                </span>
              ))}
            </div>
          </div>
        </section>

        {children}
      </div>
    </div>
  );
}
