"use client";

import { useState } from "react";
import { useHoloTilt } from "./useHoloTilt";
import { barcodeBars } from "./memberIdentity";
import { DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
import "./member-pass.css";

// MemberPass — AnimeGoClub 会员通行证. Presentational holo card: given the
// member's identity + a cover/photo, it renders the full-bleed pass with the
// pointer-driven rainbow foil + glare (engine in useHoloTilt). No rarity
// tiers. The crop modal + localStorage live in the parent (CinematicProfile).

interface MemberPassProps {
  /** Display name on the nameplate. */
  username: string;
  /** Optional romaji/latin reading shown small beside a CJK name. */
  romaji?: string | null;
  /** Stable credential mark, e.g. "AGC-000142". */
  memberNo: string;
  /** Enrolment line, e.g. "SINCE 2021.04". */
  since: string;
  /** 看过 · 部 count (completed subscriptions). */
  watchedCount: number;
  /** Most-active season label, e.g. "2024 秋季"; null hides that record. */
  topSeason: string | null;
  /** Cover image used as the card face; null → tinted gradient fallback. */
  artUrl: string | null;
  /** User-cropped photo; overrides artUrl when present. */
  photoUrl?: string | null;
  /** Membership status chip, defaults to 在籍 · 有效 / Active. */
  statusText?: string;
  lang: "zh" | "en";
  /** Defer the card art (loading="lazy"). Default eager — the card is the LCP
   *  hero on profile/settings pages. The landing /welcome card opts in because
   *  it sits far below the fold (Lighthouse offscreen-images). */
  lazy?: boolean;
}

/** Tinted SVG used when the cover fails to load — never a broken-image box. */
function artFallback(seed: string): string {
  const h = (seed.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 252 352">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h} 48% 26%)"/>` +
    `<stop offset="0.55" stop-color="hsl(${(h + 30) % 360} 42% 15%)"/>` +
    `<stop offset="1" stop-color="hsl(${(h + 60) % 360} 40% 9%)"/></linearGradient>` +
    `<radialGradient id="r" cx="0.5" cy="0.34" r="0.6">` +
    `<stop offset="0" stop-color="hsl(${h} 55% 40%)" stop-opacity="0.55"/>` +
    `<stop offset="1" stop-color="hsl(${h} 55% 40%)" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="252" height="352" fill="url(#g)"/>` +
    `<rect width="252" height="352" fill="url(#r)"/></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

export default function MemberPass({
  username,
  romaji,
  memberNo,
  since,
  watchedCount,
  topSeason,
  artUrl,
  photoUrl,
  statusText,
  lang,
  lazy = false,
}: MemberPassProps) {
  const cardRef = useHoloTilt<HTMLDivElement>();
  // SVG gradient is the last-ditch onError target; the default card image is
  // the face for users who haven't set a photo or backdrop cover.
  const fallback = artFallback(username || memberNo);
  const [src, setSrc] = useState<string>(photoUrl || artUrl || DEFAULT_CARD_IMAGE);
  const hasPhoto = Boolean(photoUrl);

  // Keep src in sync when the parent swaps photo/cover (cheap, no effect needed).
  const desired = photoUrl || artUrl || DEFAULT_CARD_IMAGE;
  const [lastDesired, setLastDesired] = useState(desired);
  if (desired !== lastDesired) {
    setLastDesired(desired);
    setSrc(desired);
  }

  const bars = barcodeBars(memberNo, 26);
  const status = statusText ?? "Active";
  const watchedLabel = lang === "zh" ? "看过 · 部" : "Watched";
  const seasonLabel = lang === "zh" ? "最活跃赛季" : "Top Season";

  return (
    <div className="agcpass-bay">
      <div
        ref={cardRef}
        className="agcpass-card"
        role="img"
        tabIndex={0}
        aria-label={
          lang === "zh"
            ? `${username} 的 AnimeGoClub 会员通行证，编号 ${memberNo}`
            : `${username}'s AnimeGoClub member pass, no. ${memberNo}`
        }
      >
        <div className="agcpass-shadow" aria-hidden="true" />
        <div className="agcpass-face">
          {/* full-bleed cover / photo */}
          <div className={`agcpass-art${hasPhoto ? " has-photo" : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={hasPhoto ? "我的卡面照片" : `${username} 卡面`}
              loading={lazy ? "lazy" : "eager"}
              decoding="async"
              onError={() => {
                if (src !== fallback) setSrc(fallback);
              }}
            />
          </div>

          {/* holo stack */}
          <div className="agcpass-rainbow" aria-hidden="true" />
          <div className="agcpass-sparkle" aria-hidden="true" />
          <div className="agcpass-glare" aria-hidden="true" />

          {/* chrome */}
          <div className="agcpass-chrome">
            <div className="agcpass-top-row">
              <span className="agcpass-cn">
                Anime<b>Go</b>Club
                <span
                  className="agcpass-vf"
                  aria-hidden="true"
                  title={lang === "zh" ? "认证会员" : "Verified member"}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 1l2.6 1.9 3.2-.2 1 3 2.6 1.8-1 3 1 3-2.6 1.8-1 3-3.2-.2L12 23l-2.6-1.9-3.2.2-1-3L2.6 16.7l1-3-1-3 2.6-1.8 1-3 3.2.2z" />
                    <path
                      d="M10.6 14.6l-2.2-2.2-1.3 1.3 3.5 3.5 6-6-1.3-1.3z"
                      fill="#0a0a0e"
                    />
                  </svg>
                </span>
              </span>
              <span className="agcpass-credential">
                <span className="agcpass-cred-no">{`#${memberNo}`}</span>
                <span className="agcpass-cred-since">{since}</span>
              </span>
            </div>

            <span className="agcpass-passpill">
              <span className="agcpass-pp-ico" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 10h18" />
                  <path d="M7 15h4" />
                </svg>
              </span>
              <span className="agcpass-pp-zh">MEMBER PASS</span>
            </span>

            <div className="agcpass-plate">
              <div className="agcpass-plate-top">
                <span className="agcpass-uname">
                  {username}
                  {romaji ? (
                    <span className="agcpass-romaji">{romaji}</span>
                  ) : null}
                </span>
                <span className="agcpass-status">{status}</span>
              </div>
              <div className="agcpass-plate-foot">
                <div className="agcpass-rec-group">
                  <div className="agcpass-rec">
                    <b>{watchedCount}</b>
                    <i>{watchedLabel}</i>
                  </div>
                  {topSeason ? (
                    <div className="agcpass-rec agcpass-rec-season">
                      <b>{topSeason}</b>
                      <i>{seasonLabel}</i>
                    </div>
                  ) : null}
                </div>
                <div
                  className="agcpass-barcode"
                  role="img"
                  aria-label={
                    lang === "zh"
                      ? `会员编号 ${memberNo} 条形码`
                      : `Member ${memberNo} barcode`
                  }
                >
                  <span className="agcpass-bars" aria-hidden="true">
                    {bars.map((bar, i) => (
                      <i
                        key={i}
                        className={`${bar.gap ? "g " : ""}${bar.width}`.trim()}
                      />
                    ))}
                  </span>
                  <span className="agcpass-bc-no">{memberNo}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
