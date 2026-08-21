"use client";

import Link from "@/components/ui/LocaleLink";
import type { CSSProperties, MouseEvent } from "react";
import { useRef } from "react";
import { formatLabel, genreLabel } from "@/lib/contentLabels";
import { formatScore, pickTitle } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n";
import { useLang } from "@/lib/lang-client";
import type { LandingPoster } from "@/lib/types";
import FadeImage from "@/components/ui/FadeImage";
import QuickSubscribeToggle from "./QuickSubscribeToggle";

// AnimeCard accepts any record that carries the title fields, cover, and
// poster-accent. Used by both legacy LandingPage components (which pass
// TrendingItem / AnimeDetail) and Phase 5 pages (Seasonal / Search). We
// add a few optional badges (rank, watcherCount) and genres lifted from
// detail responses; cards built from trending alone simply omit them.
export interface AnimeCardData {
  anilistId: number;
  titleChinese?: string | null;
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
  coverImageUrl: string | null;
  posterAccent?: string | null;
  averageScore?: number | null;
  format?: string | null;
  genres?: string[];
  discussionCount?: number;
}

interface AnimeCardProps {
  anime: AnimeCardData;
  lang: Lang;
  rank?: number;
  watcherCount?: number;
  /**
   * Phase 5 plan §UI mitigation B1: pass prefetch=false to avoid
   * Next prefetching every visible card in the seasonal/search grid
   * (those grids can render 20+ cards above-the-fold which would
   * stampede the Go API).
   */
  prefetch?: boolean;
  /** Set true for the first above-the-fold card — disables lazy load and sets fetchpriority=high. */
  priority?: boolean;
}

// Two badge labels. Both are a bare counter word glued to a number, which is
// exactly the kind of string that belongs next to the badge it sizes rather
// than in the dictionary.
//
// Note the two are read with DIFFERENT languages, and that is deliberate: the
// watcher unit follows the `lang` prop (the URL's locale, matching the count
// the server rendered), the discussion aria-label follows useLang() (the
// visitor's preference, matching the genre chips beside it). See the note at
// the viewerLang declaration below.
const WATCHER_UNIT: Record<Lang, string> = {
  zh: "人",
  en: "watching",
  "zh-Hant": "人",
};

const DISCUSSION_ARIA: Record<Lang, (count: number) => string> = {
  zh: (count) => `${count} 条讨论`,
  en: (count) => `${count} discussions`,
  "zh-Hant": (count) => `${count} 條討論`,
};

function scoreColor(s: number): string {
  if (s >= 75) return "#30d158";
  if (s >= 50) return "#ff9f0a";
  return "#ff453a";
}

// The card is a plain box that owns the frame (border/radius/clip) and the
// hover transition; the <a> lives inside it and the quick-subscribe <button>
// is the <a>'s SIBLING, not its descendant.
//
// Why a wrapper at all: a <button> inside an <a> is invalid HTML — nested
// interactives are mis-handled by screen readers and keyboards, and the only
// way to stop the anchor swallowing the button's click is
// preventDefault/stopPropagation, which also kills middle-click and
// ctrl-click on the parts of the card the user *did* mean to follow.
//
// Why the <a> is NOT an empty stretched overlay (an earlier revision made it
// one, and it cost us): an anchor with no text content ships every card grid
// — /seasonal, /search, home trending — as 20+ links to /anime/{id} carrying
// zero anchor text. Anchor text is the most direct "this URL is about this
// title" signal Google has, and this site's entire acquisition funnel is
// organic search while it is still fighting title-entity confusion with an
// unrelated pirate domain. So the <a> wraps the whole visual stack — poster,
// badges, gradient, title — and the title is anchor text again by
// construction, with nothing to keep in sync.
const cardStyle: CSSProperties = {
  display: "block",
  position: "relative",
  borderRadius: 12,
  overflow: "hidden",
  background: "#1c1c1e",
  border: "1px solid #38383a",
  transition:
    "transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1)",
  aspectRatio: "3/4",
};

// inset:0 rather than a normal-flow block: it pins the anchor to the card box
// exactly (so every pixel outside the toggle still navigates) and makes the
// anchor itself the containing block for the badges and gradient inside it,
// which keeps their `top/right/bottom/left` numbers meaning what they always
// meant. It also gives the poster's `height:100%` a definite height to
// resolve against instead of leaning on aspect-ratio percentage resolution.
// No z-index: the toggle sits at z-index 2 and paints above regardless. The
// negative outline offset keeps the focus ring inside the card's
// overflow:hidden clip.
const cardLinkStyle: CSSProperties = {
  display: "block",
  position: "absolute",
  inset: 0,
  borderRadius: 12,
  textDecoration: "none",
  color: "inherit",
  outlineOffset: -3,
};

const imgStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};


const rankBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  color: "#0a84ff",
  fontSize: 20,
  fontWeight: 900,
  lineHeight: 1,
  fontFamily: "'Sora', sans-serif",
  background: "rgba(0,0,0,0.65)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  padding: "4px 8px",
  borderRadius: 6,
};

const formatBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(8px)",
  color: "rgba(235,235,245,0.60)",
  fontSize: 10,
  fontWeight: 700,
  padding: "3px 7px",
  borderRadius: 5,
  letterSpacing: "0.5px",
};

const scoreBadgeBase: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(8px)",
  fontSize: 11,
  fontWeight: 700,
  padding: "3px 7px",
  borderRadius: 6,
  fontFamily: "'JetBrains Mono', monospace",
};

const watcherBadgeStyle: CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(8px)",
  color: "#5ac8fa",
  fontSize: 10,
  fontWeight: 700,
  padding: "3px 7px",
  borderRadius: 5,
};

const discussionBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 35,
  left: 8,
  background: "rgba(0,0,0,0.78)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  color: "#64d2ff",
  fontSize: 10,
  fontWeight: 750,
  padding: "3px 7px",
  borderRadius: 999,
  fontFamily: "'JetBrains Mono', monospace",
};

const gradientStyle: CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  background:
    "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 55%, transparent 100%)",
  padding: "32px 10px 10px",
};

const overlayStyle: CSSProperties = {
  opacity: 0,
  transition: "opacity 0.25s",
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginBottom: 6,
};

const genreChipStyle: CSSProperties = {
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 9999,
  background: "rgba(120,120,128,0.12)",
  color: "rgba(235,235,245,0.60)",
  fontWeight: 500,
};

const titleStyle: CSSProperties = {
  fontFamily: "'Sora', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  color: "#ffffff",
  lineHeight: 1.35,
  margin: 0,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  // Reserve the bottom-right corner for the quick-subscribe pill, and not one
  // pixel more. Every px here is charged to BOTH clamped lines, and the CJK
  // fallback face is full-width, so at font-size 13 a glyph advances exactly
  // 13px: 4px of slop costs ~a third of a character per line, twice over.
  //
  // Geometry, all measured from the card's PADDING box right edge (which is
  // what both this anchor's inset:0 and the toggle's right:3 resolve against).
  // QuickSubscribeToggle keeps its layout numbers module-private, so these are
  // transcribed, not imported — if HIT_SIZE/PILL_SIZE/EDGE_INSET move there,
  // this constant has to move with them:
  //   hit box  44px wide at right:3          → spans  3→47
  //   pill     34px centred in it, (44-34)/2 → spans  8→42, centre 25, r=17
  //   gradient padding already insets text          10
  //   ⇒ paddingRight = 42 - 10 = 32
  //
  // 32 is the exact tangent, not a rounded guess, and it is genuinely the
  // floor: the pill is a circle centred 25px up from the card bottom, while
  // the two 17.55px lines span y=10→27.6 (line 2) and y=27.6→45.1 (line 1) —
  // i.e. BOTH straddle the circle's widest point, which is why neither line
  // can be let off. A reviewer suggested 28; that lets text reach x=38, where
  // the disc is still 22px tall (y=14→36) and opaque at 0.72-0.92 alpha, so
  // both lines would run under solid paint. Even 31 clips (disc y=19→31).
  //
  // Payoff over the 36 this replaces, at the tightest real layout — 360px
  // viewport, 16px container padding, 2-col grid, 12px gap → 158px card,
  // 156px inside the border: text box 100px → 104px, i.e. 7 → 8 full-width
  // glyphs per line, 14 → 16 characters before the ellipsis.
  paddingRight: 32,
};

export default function AnimeCard({
  anime,
  lang,
  rank,
  watcherCount,
  prefetch = false,
  priority = false,
}: AnimeCardProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Content enums (format badge, genre chips) deliberately do NOT use the
  // `lang` prop. That prop is the URL's locale; useLang() is the visitor's
  // cookie preference, and on a bare (Chinese) URL — where most search
  // traffic lands — those disagree. Following the cookie keeps these chips
  // English for an English reader instead of the "zh" the prop would give.
  // useLang() is SSR-seeded from the route locale and reconciled from
  // the `lang` cookie after mount: the same source SearchFilters and
  // SeasonalFilterChips read, so a card badge can never disagree with the
  // filter chip sitting directly above it in the /search and /seasonal grids.
  const { lang: viewerLang } = useLang();
  const href = `/anime/${anime.anilistId}`;
  const title = pickTitle(anime, lang);

  // Hover lives on the card box, not the link. Keeping it on the anchor would
  // drop the lift/shadow whenever the pointer crossed the toggle, since the
  // toggle sits above the anchor and would steal the mouseleave. On the box
  // both the anchor and the toggle are descendants, so enter/leave only fire
  // at the card's real boundary.
  const onEnter = (e: MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.transform = "translateY(-4px)";
    el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.40)";
    if (overlayRef.current) overlayRef.current.style.opacity = "1";
  };
  const onLeave = (e: MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.transform = "none";
    el.style.boxShadow = "none";
    if (overlayRef.current) overlayRef.current.style.opacity = "0";
  };

  return (
    <div className="agc-card" style={cardStyle} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {/* No aria-label. The anchor now contains the title, so its accessible
          name is computed from that text — one string doing both jobs, which
          is also what stops the two from ever drifting apart. An aria-label
          would silently override the visible text for AT (and Google treats
          it as a competing link-text signal), for no gain: the name it would
          produce is the name the content already produces.

          Dropping it does move work onto the subtree, though: a link's name is
          the concatenation of its contents, so every un-hidden descendant now
          joins it. Everything in here that is NOT the title is therefore
          aria-hidden, and the reason is ordering as much as verbosity — the
          badges paint in the corners but sit BEFORE the title in DOM order, so
          leaving one audible would name all 20 links in a grid
          "TV ★ 8.9 <title>", burying the only part that differs at the end of
          every announcement. That is also exactly what the old
          aria-label={title} produced (a label overrides contents outright), so
          hiding them holds screen-reader behaviour where it already was while
          the crawler gains the anchor text. The metadata stays visible to
          sighted users and is repeated in full on the detail page. */}
      <Link href={href} prefetch={prefetch} style={cardLinkStyle}>
        {anime.coverImageUrl ? (
          // alt is kept for image search, but hidden from the a11y tree: it
          // is verbatim the title rendered a few lines below, and without
          // this the link would announce the name twice. This is the one
          // genuine duplicate that dropping aria-label exposed.
          <FadeImage
            src={anime.coverImageUrl}
            alt={title}
            aria-hidden
            width={230}
            height={320}
            priority={priority}
            style={imgStyle}
          />
        ) : (
          <div style={{ ...imgStyle, background: "#2c2c2e" }} aria-hidden />
        )}

        {rank ? (
          <span style={rankBadgeStyle} aria-hidden>
            #{rank}
          </span>
        ) : anime.format ? (
          <span style={formatBadgeStyle} aria-hidden>
            {formatLabel(anime.format, viewerLang)}
          </span>
        ) : null}

        {anime.averageScore != null && anime.averageScore > 0 ? (
          <span
            style={{ ...scoreBadgeBase, color: scoreColor(anime.averageScore) }}
            aria-hidden
          >
            ★ {formatScore(anime.averageScore)}
          </span>
        ) : null}

        {watcherCount && watcherCount > 0 ? (
          <span style={watcherBadgeStyle} aria-hidden>
            {watcherCount} {WATCHER_UNIT[lang]}
          </span>
        ) : null}

        {anime.discussionCount != null && anime.discussionCount > 0 ? (
          <span
            style={discussionBadgeStyle}
            aria-label={DISCUSSION_ARIA[viewerLang](anime.discussionCount)}
          >
            💬 {anime.discussionCount > 999 ? "999+" : anime.discussionCount}
          </span>
        ) : null}

        <div style={gradientStyle}>
          {/* aria-hidden: these chips are opacity 0 until hover, so they are
              decoration for pointer users rather than part of the link's
              name — and they would otherwise be announced on every card in a
              20-card grid despite being invisible.
              key stays the raw AniList enum (stable identity); only the
              rendered text is localised. */}
          <div ref={overlayRef} style={overlayStyle} aria-hidden>
            {(anime.genres ?? []).slice(0, 2).map((g) => (
              <span key={g} style={genreChipStyle}>
                {genreLabel(g, viewerLang)}
              </span>
            ))}
          </div>
          <p style={titleStyle}>{title}</p>
        </div>
      </Link>

      {/* Sibling of the anchor, never a descendant: valid HTML, and it takes
          its own clicks natively because it is painted last and at z-index 2
          — no preventDefault/stopPropagation, so middle-click and ctrl-click
          keep working everywhere else on the card. Placed after the anchor in
          DOM order so Tab reaches "open this anime" first, "track it"
          second. */}
      <QuickSubscribeToggle anilistId={anime.anilistId} title={title} />
    </div>
  );
}

// Re-export the LandingPoster union so consumers that already typed
// against TrendingItem / AnimeDetail can pass them as AnimeCardData
// without an extra cast — the structural overlap is full.
export type { LandingPoster };
