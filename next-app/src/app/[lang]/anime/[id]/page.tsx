// Phase 5.A: /anime/[id] detail RSC + ISR (60s).
//
// Design notes (vs legacy AnimeDetailPage.jsx):
//   - SEO-critical surfaces only (hero + relations + characters + staff +
//     recommendations). Subscription / Watchers / EpisodeList / TorrentModal
//     / PlayButton are interactive and ride client routes in Phase 6.
//   - JSON-LD TVSeries schema injected for Google Rich Results
//     (plan Phase 5 acceptance gate).
//   - No 'use client': every block here is static markup; the read-more
//     toggle and accent-cache writes from the legacy hero do NOT belong on
//     a server-rendered SEO surface (they're client niceties).
//   - generateMetadata reuses the same apiGet so Next memoizes the fetch
//     within the request; no double load on the Go API.

import type { Metadata } from "next";
import Link from "@/components/ui/LocaleLink";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import DescriptionExpand from "@/components/anime/DescriptionExpand";
import DetailActions from "@/components/anime/DetailActions";
import FadeImage from "@/components/ui/FadeImage";
import EpisodesGrid from "@/components/anime/EpisodesGrid";
import { resolveEpisodeSkeleton } from "@/components/anime/episodeGridSkeleton";
import HeroAccent from "@/components/anime/HeroAccent";
import { FormatBadge, GenreChips } from "@/components/anime/LocalizedChips";
import WatchersAvatarList from "@/components/anime/WatchersAvatarList";
import { apiGet, ApiError } from "@/lib/api";
import {
  durationLabel,
  pickRelatedTitle,
  relationLabel,
  sourceLabel,
  staffRoleLabel,
} from "@/lib/contentLabels";
import {
  formatFuzzyDate,
  formatScore,
  pickCharacterName,
  pickDescription,
  pickSeoTitle,
  pickStaffName,
  pickTitle,
  pickVoiceActorName,
  stripHtml,
  truncate,
  truncateVisual,
  visualWidth,
} from "@/lib/formatters";
import { resolveLocale } from "@/lib/i18n/route";
import { LOCALES } from "@/lib/i18n/locale";
import { buildAlternates } from "@/lib/seo/alternates";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import type {
  AnimeDetail,
  DetailCharacter,
  DetailRecommendation,
  DetailRelation,
  DetailStaff,
} from "@/lib/types";

// ISR window — matches landing trending revalidate (60s) so cached
// upstream payloads cascade naturally.
export const revalidate = 60;

// A `[param]` route is `ƒ Dynamic` (and `revalidate` is ignored) unless it
// exports generateStaticParams. We prerender the trending set at build time;
// dynamicParams=true keeps every other id ISR-on-demand (rendered + cached on
// first request) instead of 404. Without this the whole route stays dynamic.
export const dynamicParams = true;

// --- Where content labels are (and are not) language-aware on this route ---
//
// `lang` throughout this file is now the ROUTE's locale (resolveLocale), not a
// pinned constant. Until the locale migration it came from getLang(), which
// returned "zh" unconditionally so the route could stay ISR + edge-cached as
// one cached HTML for every visitor; every zh/en branch fed by it therefore
// resolved zh even for English readers.
//
// The cache is still safe, and for the same reason it always was: the locale
// is part of the URL, so /anime/21 and /en/anime/21 are two different cache
// entries rather than one entry serving two languages. Nothing here reads a
// cookie or a header. That is the property to preserve — if this route ever
// resolves language from anything other than the path, one visitor's language
// gets cached for everyone.
//
// So pickTitle, pickStaffName, pickCharacterName, RELATION_LABEL,
// CHARACTER_ROLE_LABEL, statusLabel, seasonLabel, staffRoleLabel and
// pickRelatedTitle now follow the URL. /anime/21 is unchanged — the default
// locale maps to "zh", exactly what the pinned value produced.
//
// Two surfaces still render through client leaves (LocalizedChips) and follow
// the `lang` COOKIE after mount rather than the URL: the genre row and the
// format badge. That is now a divergence rather than the workaround it was
// created as — see the note beside SeasonalFilterChips in
// seasonal/[season]/[year]/page.tsx. Reconciling URL locale against cookie
// preference is one decision for the whole site, not a per-chip one.
//
// Do not extend the client-leaf treatment item-by-item to staff roles or
// relation / recommendation titles. Those are dozens of nodes each, they are
// server-resolved correctly now, and adding hydration roots would buy nothing
// but cost.

// Prerender a small, hot set of detail pages from the trending endpoint —
// same path + unwrapped TrendingItem[] shape the landing page's safeTrending
// uses (/api/anime/trending?limit=N → TrendingItem[] with `anilistId`).
// auth:false keeps the build-time fetch anonymous (no cookies()/headers()).
// MUST NOT break a build where go-api is unreachable: on any error we return
// [] so 0 pages prerender and all ids fall through to ISR-on-demand. CI has no
// backend and still has to exit 0 — do not add a throw path here.
//
// The result is the full LOCALES × ids product, and it has to be built here
// rather than left to the root layout's localeParams(). A route with its own
// generateStaticParams supplies EVERY param in its path, `lang` included; a
// list of bare `{ id }` would not name the locale segment at all. Returning
// half the product does not fail the build or the ISR gate — it silently
// prerenders one locale and leaves the other to render on demand, which is
// invisible in the route table and in assert-isr.mjs alike.
export async function generateStaticParams(): Promise<
  Array<{ lang: string; id: string }>
> {
  let ids: string[];
  try {
    const trending = await apiGet<Array<{ anilistId: number }>>(
      "/api/anime/trending?limit=20",
      { revalidate: 3600, auth: false },
    );
    ids = trending.map((a) => String(a.anilistId));
  } catch {
    return [];
  }
  return LOCALES.flatMap((lang) => ids.map((id) => ({ lang, id })));
}

type AnimeDetailPageProps = PageProps<"/[lang]/anime/[id]">;

// --- Detail fetch helper (shared by generateMetadata + default export) ---

async function loadDetail(id: number): Promise<AnimeDetail | null> {
  try {
    // auth:false — detail data is public / not user-scoped, so skip the
    // cookies()/headers() read that would force this page dynamic (ISR-safe).
    return await apiGet<AnimeDetail>(`/api/anime/${id}`, {
      revalidate: 60,
      auth: false,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// --- Status / source / season labels ---

const RELATION_ORDER = [
  "PREQUEL",
  "SEQUEL",
  "PARENT",
  "SIDE_STORY",
  "SPIN_OFF",
  "ADAPTATION",
  "ALTERNATIVE",
  "SUMMARY",
  "CHARACTER",
  "OTHER",
];

const CHARACTER_ROLE_LABEL: Record<Lang, Record<string, string>> = {
  zh: { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
  en: { MAIN: "Main", SUPPORTING: "Supporting", BACKGROUND: "Background" },
  // All three are script-identical — no conversion needed, only a row.
  "zh-Hant": { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
};

/**
 * Whether the H1 gets the Japanese (or romaji) original beneath it.
 *
 * Not a script question — a redundancy one. A Chinese H1 is a translation, so
 * the original is extra information worth showing; the English H1 already IS
 * titleEnglish or titleRomaji, so a romaji subtitle under it would repeat the
 * line above. zh-Hant is in the first group.
 *
 * Written as `lang === "zh" && …` before, which silently put every language
 * that was not Simplified into the second group — so a Traditional reader
 * lost the Japanese subtitle entirely, on every detail page, with nothing to
 * see in review because the H1 above it was correct.
 */
const SHOWS_ORIGINAL_SUBTITLE: Record<Lang, boolean> = {
  zh: true,
  en: false,
  "zh-Hant": true,
};

function scoreColor(s: number): string {
  if (s >= 75) return "#30d158";
  if (s >= 50) return "#ff9f0a";
  return "#ff453a";
}

function statusLabel(dict: Dict, status: string | null): string {
  if (!status) return "";
  const map: Record<string, string> = {
    RELEASING: dict.detail.releasing,
    FINISHED: dict.detail.finished,
    NOT_YET_RELEASED: dict.detail.notYetReleased,
    CANCELLED: dict.detail.cancelled,
  };
  return map[status] ?? status;
}

function seasonLabel(dict: Dict, season: string | null): string | null {
  if (!season) return null;
  const seasons = dict.season as unknown as Record<string, string>;
  return seasons[season] ?? season;
}

// --- generateMetadata: title / description / OG / Twitter / canonical ---

export async function generateMetadata({
  params,
}: AnimeDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = Number(id);
  if (!Number.isFinite(anilistId) || anilistId <= 0) {
    return { title: { absolute: "AnimeGoClub" } };
  }

  const [{ locale, lang }, detail] = await Promise.all([
    resolveLocale(params),
    loadDetail(anilistId),
  ]);
  if (!detail) {
    return { title: { absolute: "AnimeGoClub" } };
  }

  // pickSeoTitle, not pickTitle. Everything this function returns is read by a
  // machine — <title>, og:title, twitter:title — and for zh-Hant that means
  // reading titleHantSeo, which the database leaves NULL on any row whose
  // Traditional title came out of a converter. The visible <h1> further down
  // still uses pickTitle; see the note on pickSeoTitle for why the two differ.
  const title = pickSeoTitle(detail, lang);
  const titleFull = `${title} · AnimeGoClub`;
  const description = truncate(stripHtml(detail.description || ""), 160);
  const ogLocale = OG_LOCALE[lang];
  const heroImage = detail.bannerImageUrl || detail.coverImageUrl || null;
  const canonical = `/anime/${anilistId}`;

  const openGraph: Metadata["openGraph"] = {
    title,
    description,
    siteName: "AnimeGoClub",
    locale: ogLocale,
    alternateLocale: alternateOgLocales(lang),
    type: "video.tv_show",
    url: canonical,
  };
  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title,
    description,
  };
  if (heroImage) {
    openGraph.images = [heroImage];
    twitter.images = [heroImage];
  }

  return {
    title: { absolute: titleFull },
    description,
    openGraph,
    twitter,
    // This route deleted its false `?lang=en` alternate in d91c753 and was
    // the only one that did; the helper now enforces the same answer
    // everywhere, and grows a real languages map when localized URLs exist.
    alternates: buildAlternates(canonical, locale),
  };
}

// --- JSON-LD TVSeries schema (Phase 5 acceptance) ---

interface JsonLdAggregateRating {
  "@type": "AggregateRating";
  ratingValue: number;
  // Google rejects AggregateRating without a count (ratingCount/reviewCount).
  // Only Bangumi gives us a real vote count, so the rating is sourced from
  // Bangumi (score + votes), matching the visible "★ x.x (n)" badge on-page.
  ratingCount: number;
  bestRating: number;
  worstRating: number;
}

interface JsonLdTVSeries {
  "@context": "https://schema.org";
  "@type": "TVSeries";
  name: string;
  alternateName?: string[];
  image?: string;
  description?: string;
  numberOfEpisodes?: number;
  startDate?: string;
  genre?: string[];
  aggregateRating?: JsonLdAggregateRating;
  productionCompany?: { "@type": "Organization"; name: string }[];
}

function buildJsonLd(detail: AnimeDetail, lang: Lang): JsonLdTVSeries {
  const alts = [detail.titleRomaji, detail.titleEnglish, detail.titleNative].filter(
    (s): s is string => Boolean(s),
  );
  const ld: JsonLdTVSeries = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    // JSON-LD `name` is the most explicit "this page is about a thing called
    // X" signal on the page, so it takes the SERP-safe field for the same
    // reason <title> does.
    name: pickSeoTitle(detail, lang),
  };
  if (alts.length) ld.alternateName = alts;
  if (detail.coverImageUrl) ld.image = detail.coverImageUrl;
  const desc = stripHtml(detail.description || "");
  if (desc) ld.description = desc;
  if (detail.episodes) ld.numberOfEpisodes = detail.episodes;
  const formattedStartDate = formatFuzzyDate(detail.startDate);
  if (formattedStartDate) ld.startDate = formattedStartDate;
  if (detail.genres?.length) ld.genre = detail.genres;
  // Bangumi rating carries a real vote count (Subject.Rating.Count), which
  // Google requires for a valid AggregateRating. AniList's averageScore has
  // no count, so an AniList-sourced rating is always rejected — omit it.
  if (
    detail.bangumiScore &&
    detail.bangumiScore > 0 &&
    detail.bangumiVotes &&
    detail.bangumiVotes > 0
  ) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: detail.bangumiScore,
      ratingCount: detail.bangumiVotes,
      bestRating: 10,
      worstRating: 1,
    };
  }
  if (detail.studios?.length) {
    ld.productionCompany = detail.studios.map((name) => ({
      "@type": "Organization",
      name,
    }));
  }
  return ld;
}

// --- Style tokens (kept inline; matches legacy hero spec) ---

const S = {
  bannerOverlay: {
    position: "absolute" as const,
    inset: 0,
    background:
      "linear-gradient(to bottom, transparent 0%, transparent 40%, rgba(0,0,0,0.30) 65%, rgba(0,0,0,0.95) 100%)",
  },
  cover: {
    width: 210,
    height: 300,
    objectFit: "cover" as const,
    borderRadius: 12,
    border: "1px solid rgba(84,84,88,0.65)",
    background: "#1c1c1e",
    display: "block",
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(22px, 4vw, 36px)",
    color: "#ffffff",
    marginBottom: 4,
    lineHeight: 1.2,
  },
  subtitle: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 15,
    marginBottom: 16,
  },
  badgeRow: { display: "flex" as const, flexWrap: "wrap" as const, gap: 10, marginBottom: 16 },
  badge: (bg: string, color: string): CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 9999,
    background: bg,
    color,
    fontSize: 13,
  }),
  scoreBadge: (color: string): CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 9999,
    background: "rgba(255,159,10,0.12)",
    color,
    fontWeight: 700,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
  }),
  bgmScoreBadge: {
    padding: "4px 12px",
    borderRadius: 9999,
    background: "rgba(255,69,58,0.10)",
    color: "#ff453a",
    fontWeight: 700 as const,
    fontSize: 13,
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 5,
    fontFamily: "'JetBrains Mono', monospace",
  },
  bgmLabel: { fontSize: 10, opacity: 0.7, fontFamily: "'DM Sans', sans-serif" },
  bgmVotes: { fontSize: 11, opacity: 0.6, fontWeight: 400 },
  bgmLink: {
    padding: "4px 12px",
    borderRadius: 9999,
    background: "rgba(255,69,58,0.10)",
    color: "#ff453a",
    fontSize: 13,
    textDecoration: "none",
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 4,
    fontWeight: 500 as const,
  },
  metaRow: {
    display: "flex" as const,
    flexWrap: "wrap" as const,
    gap: "4px 12px",
    marginBottom: 16,
    alignItems: "center" as const,
  },
  metaStudio: { color: "rgba(235,235,245,0.75)", fontSize: 13 },
  metaDot: { color: "rgba(84,84,88,0.65)", fontSize: 13 },
  metaDetail: { color: "rgba(235,235,245,0.50)", fontSize: 12 },
  genreRow: { display: "flex" as const, flexWrap: "wrap" as const, gap: 6, marginBottom: 20 },
  genreTag: {
    padding: "4px 10px",
    borderRadius: 9999,
    background: "rgba(120,120,128,0.12)",
    color: "rgba(235,235,245,0.60)",
    fontSize: 12,
    fontWeight: 500 as const,
  },
  descText: {
    color: "rgba(235,235,245,0.75)",
    fontSize: 14,
    lineHeight: 1.8,
  },
  sectionLabel: {
    color: "#0a84ff",
    fontSize: 13,
    fontWeight: 600 as const,
    letterSpacing: "2px",
    textTransform: "uppercase" as const,
    marginBottom: 16,
  },
} satisfies Record<string, CSSProperties | ((...args: never[]) => CSSProperties)>;

// --- Hero (banner + cover + meta block) ---

// Relation types we surface inline in the hero (matches the legacy
// SHOWN_RELATIONS set). RecommendationsSection further down still
// renders the full relation set; this inline strip is a UX shortcut so
// users see the prequel/sequel without scrolling.
const HERO_SHOWN_RELATIONS = new Set([
  "PREQUEL",
  "SEQUEL",
  "PARENT",
  "SIDE_STORY",
  "SPIN_OFF",
]);

// Collapsed-description budget, in "latin character" units — CJK counts two.
// Measuring width rather than characters keeps the collapsed block the same
// apparent size in both scripts. With a plain character count the Chinese
// summaries all sat under the threshold (55-289 chars) while their English
// counterparts ran well over it (235-1100), so the read-more control appeared
// only for English readers and Chinese readers got the whole synopsis dumped
// into the hero.
const DESC_TRUNCATE_WIDTH = 300;

function Hero({ detail, lang, dict }: { detail: AnimeDetail; lang: Lang; dict: Dict }) {
  const title = pickTitle(detail, lang);
  // Full description for SEO; truncated mirror for the collapsed UI
  // state. The client-side toggle in DescriptionExpand swaps between
  // them so the rendered HTML always contains both (crawlers see the
  // full text inside the rendered <p>).
  //
  // zh readers get description_cn — Bangumi's community-written Chinese
  // synopsis — when the column is populated, falling back to AniList's
  // English description otherwise. Until the enrichment backfill runs, the
  // column is NULL for every row and this resolves to exactly what
  // `detail.description` resolved to before.
  //
  // `lang` is the URL's locale, not the visitor's cookie preference. This body
  // copy is baked server-side and the lang-client provider never swaps it, so
  // an en-cookie visitor reading /anime/21 still gets the Chinese synopsis —
  // they have to be at /en/anime/21 for pickDescription's `en` branch to fire.
  // That is the same trade this page makes for titles and relation titles
  // (pickTitle / pickRelatedTitle, see the route note up top): the page's
  // language is the address, consistently, top to bottom.
  //
  // Before the locale migration this branch was unreachable at any URL, since
  // getLang() returned "zh" for every server render. It is live now.
  //
  // ── SEO BOUNDARY — read before "fixing" the two other description reads ──
  // This is the *body copy* only. generateMetadata's `description` (the
  // meta/og/twitter tag, ~line 205) and buildJsonLd's `description` (~line
  // 283) still read detail.description on purpose, so the indexed text does
  // not change under Google while the visible page does. Swapping the
  // indexed description is its own phase: bucketed rollout plus GSC
  // observation, because a catalog-wide description rewrite is exactly the
  // kind of change that moves rankings in either direction with no way to
  // attribute it after the fact. Do not "make them consistent" here.
  const desc = pickDescription(detail, lang);
  const descFull = stripHtml(desc.text);
  const descTruncated = truncateVisual(descFull, DESC_TRUNCATE_WIDTH);
  const descNeedsToggle = visualWidth(descFull) > DESC_TRUNCATE_WIDTH;
  // Attribution + snippet exclusion hang off the provenance of the text.
  //
  //   - 'bangumi': credit (linked when the binding survives) + nosnippet —
  //     text we transcribed from bgm.tv.
  //   - 'llm': an "AI-translated" note + nosnippet. The note is honesty
  //     (readers judge machine translation differently) and nosnippet keeps
  //     machine text out of Google's snippets entirely — the same SERP
  //     boundary that keeps generateMetadata / JSON-LD on the English
  //     original applies one layer down here.
  //   - 'opencc': a Simplified-to-Traditional conversion of one of the above.
  //     It arrived with zh-Hant and was briefly the one machine-made source
  //     that carried neither a note nor nosnippet, because both flags named
  //     their sources individually — so the identical prose was disclosed on
  //     /anime/:id and undisclosed on /zh-Hant/anime/:id.
  //   - 'manual' still does not exist; our own editorial text will have no
  //     reason to be held out of snippets when it does.
  //
  // nosnippet is therefore computed from "is there any provenance at all"
  // rather than from a list of sources. A tier added later is held out of
  // snippets until someone decides otherwise, which is the direction this
  // should fail in — the same reason title_hant_seo names the sources it
  // admits instead of the one it excludes.
  //
  // Neither flag is gated on bgmId. bgmId only decides whether the bangumi
  // credit is a link: a row that lost its binding after the summary was
  // written would otherwise silently drop the credit while still
  // republishing the text.
  const isBangumiSummary = desc.source === "bangumi";
  const isLlmSummary = desc.source === "llm";
  const isConvertedSummary = desc.source === "opencc";
  // A conversion inherits the honesty debt of what it converted. The
  // Simplified text under a zh-Hant page is very often the LLM translation,
  // and "converted to Traditional" alone would quietly drop the far more
  // important half of that sentence.
  const convertedFromLlm = isConvertedSummary && detail.descriptionCnSource === "llm";
  const summaryIsDerived = desc.source !== null && desc.source !== undefined;
  const bgmSummaryHref = detail.bgmId
    ? `https://bgm.tv/subject/${detail.bgmId}`
    : undefined;
  const heroRelations = (detail.relations ?? []).filter((r) =>
    HERO_SHOWN_RELATIONS.has(r.relationType),
  );
  const sourceText = sourceLabel(detail.source, lang);
  const durationText = durationLabel(detail.duration, lang);
  const seasonLab = seasonLabel(dict, detail.season);
  const score = detail.averageScore;
  const accent = detail.posterAccent || null;
  const startDateLabel = formatFuzzyDate(detail.startDate, lang);
  // Shared with EpisodesGrid below the fold, so the badge and the grid can
  // never disagree about whether this show's episode count is known.
  //
  // Only the `authoritative` case prints a number. `inferred` is a floor
  // derived from however many episode titles we happen to hold, and printing
  // a floor next to the studio and the season would present it as the total —
  // on a page Google indexes, in the same badge row that carries the score.
  // buildJsonLd applies the same rule from the same field (numberOfEpisodes
  // is set only when detail.episodes is truthy) and is deliberately left
  // alone: an inferred count must not reach schema.org either.
  const episodeSkeleton = resolveEpisodeSkeleton(detail.episodes, detail.episodeTitles ?? []);

  return (
    <div>
      {/* Banner */}
      <div
        style={{
          position: "relative",
          height: detail.bannerImageUrl ? 400 : 120,
          background: detail.bannerImageUrl
            ? `url(${detail.bannerImageUrl}) center/cover`
            : "#000000",
          overflow: "hidden",
        }}
      >
        <div style={S.bannerOverlay} />
      </div>

      {/* Content */}
      <div
        className="container"
        style={{
          display: "flex",
          gap: 32,
          marginTop: detail.bannerImageUrl ? -80 : 24,
          position: "relative",
          zIndex: 1,
          paddingBottom: 40,
          flexWrap: "wrap",
        }}
      >
        {/* Cover — `hero-cover` class lets HeroAccent's halo CSS attach.
            Halo color comes from --poster-accent on the HeroAccent wrapper. */}
        <div style={{ flexShrink: 0 }}>
          {detail.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <FadeImage
              src={detail.coverImageUrl}
              alt={title}
              width={210}
              height={300}
              priority
              className="hero-cover"
              style={S.cover}
            />
          ) : (
            <div style={{ ...S.cover, background: "#2c2c2e" }} aria-hidden />
          )}
        </div>

        {/* Meta */}
        <div style={{ flex: 1, minWidth: 280, paddingTop: detail.bannerImageUrl ? 60 : 0 }}>
          <h1 style={S.title}>{title}</h1>
          {SHOWS_ORIGINAL_SUBTITLE[lang] && (detail.titleNative || detail.titleRomaji) && (
            <p style={S.subtitle}>{detail.titleNative || detail.titleRomaji}</p>
          )}

          {/* Badges */}
          <div style={S.badgeRow}>
            {score && score > 0 ? (
              <span style={S.scoreBadge(scoreColor(score))}>
                {"★"} {formatScore(score)}
              </span>
            ) : null}
            {detail.bangumiScore && detail.bangumiScore > 0 ? (
              <span style={S.bgmScoreBadge}>
                <span style={S.bgmLabel}>BGM</span>
                {"★"} {detail.bangumiScore.toFixed(1)}
                {detail.bangumiVotes && detail.bangumiVotes > 0 ? (
                  <span style={S.bgmVotes}>({detail.bangumiVotes.toLocaleString()})</span>
                ) : null}
              </span>
            ) : null}
            {detail.format && (
              // Client leaf so this follows the cookie language rather than
              // the server-pinned zh — see the route note at the top of this
              // file for why only this and the genre row get that treatment.
              <FormatBadge
                format={detail.format}
                style={S.badge("rgba(10,132,255,0.12)", "#0a84ff")}
              />
            )}
            {detail.status && (
              <span style={S.badge("rgba(90,200,250,0.10)", "#5ac8fa")}>
                {statusLabel(dict, detail.status)}
              </span>
            )}
            {episodeSkeleton.kind === "authoritative" ? (
              <span style={S.badge("rgba(120,120,128,0.12)", "rgba(235,235,245,0.60)")}>
                {episodeSkeleton.total} {dict.detail.epUnit}
              </span>
            ) : (
              <span style={S.badge("rgba(120,120,128,0.12)", "rgba(235,235,245,0.42)")}>
                {dict.detail.episodeCountPending}
              </span>
            )}
            {seasonLab && detail.seasonYear ? (
              <span style={S.badge("rgba(120,120,128,0.12)", "rgba(235,235,245,0.60)")}>
                {seasonLab} {detail.seasonYear}
              </span>
            ) : null}
            {detail.bgmId ? (
              <a
                href={`https://bgm.tv/subject/${detail.bgmId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={S.bgmLink}
              >
                <span style={{ fontSize: 10, opacity: 0.8 }}>{"▶"}</span>
                {dict.detail.viewOnBgm}
              </a>
            ) : null}
          </div>

          {/* Meta row */}
          {(detail.studios.length > 0 || sourceText || durationText || startDateLabel) && (
            <div style={S.metaRow}>
              {detail.studios.length > 0 && (
                <span style={S.metaStudio}>{detail.studios.join(" · ")}</span>
              )}
              {detail.studios.length > 0 &&
                (sourceText || durationText || startDateLabel) && (
                  <span style={S.metaDot}>{"·"}</span>
                )}
              {sourceText && <span style={S.metaDetail}>{sourceText}</span>}
              {durationText && <span style={S.metaDetail}>{durationText}</span>}
              {startDateLabel && <span style={S.metaDetail}>{startDateLabel}</span>}
            </div>
          )}

          {/* Genres — client leaf for the same reason as FormatBadge above.
              One instance for the whole row, not one per chip. Only the chip
              text is localised: buildJsonLd still emits detail.genres raw, so
              schema.org keeps the English AniList vocabulary. */}
          <GenreChips
            genres={detail.genres}
            style={S.genreRow}
            chipStyle={S.genreTag}
          />

          {/* Description with 展开更多 / 收起 toggle */}
          {descFull && (
            <div style={{ marginBottom: heroRelations.length > 0 ? 20 : 0 }}>
              <DescriptionExpand
                truncated={descTruncated}
                full={descFull}
                needsToggle={descNeedsToggle}
                expandLabel={dict.detail.readMore}
                collapseLabel={dict.detail.collapse}
                nosnippet={summaryIsDerived}
                sourceLabel={
                  isBangumiSummary
                    ? dict.detail.summaryFromBangumi
                    : isLlmSummary
                      ? dict.detail.summaryFromLlm
                      : convertedFromLlm
                        ? dict.detail.summaryConvertedFromLlm
                        : isConvertedSummary
                          ? dict.detail.summaryConverted
                          : undefined
                }
                sourceHref={isBangumiSummary ? bgmSummaryHref : undefined}
              />
            </div>
          )}

          {/* Inline relations (prequel / sequel / parent / side story /
              spin-off) — matches legacy AnimeDetailHero.jsx behavior of
              keeping the most important relations close to the title
              instead of forcing the user to scroll to the relations
              section. The full RelationsSection still renders below. */}
          {heroRelations.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 12,
              }}
            >
              {heroRelations.map((r) => {
                const relLabel =
                  relationLabel(r.relationType, lang);
                // Was `r.title || r.titleChinese` — legacy AnimeDetailHero.jsx
                // pinned romaji, so a Chinese title sitting right there in the
                // payload was never shown (prod: 48.7% of relation rows carry
                // one). pickRelatedTitle prefers it under zh. `lang` is
                // server-pinned zh here, so this reads Chinese-first for every
                // visitor — same as pickTitle two screens up; see the route
                // note at the top of this file. Wire field is `title` not
                // `titleRomaji` — see DetailRelation type.
                const relTitle =
                  pickRelatedTitle(r, lang) || `Anime #${r.anilistId}`;
                return (
                  <Link
                    key={`${r.relationType}-${r.anilistId}`}
                    href={`/anime/${r.anilistId}`}
                    className="hero-relation-chip"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 12px",
                      borderRadius: 8,
                      background: "rgba(120,120,128,0.12)",
                      border: "1px solid rgba(84,84,88,0.65)",
                      color: "rgba(235,235,245,0.60)",
                      fontSize: 12,
                      fontWeight: 500,
                      textDecoration: "none",
                    }}
                  >
                    <span
                      style={{
                        color: "rgba(235,235,245,0.35)",
                        fontSize: 11,
                      }}
                    >
                      {relLabel}
                    </span>
                    {relTitle}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Relations section ---

function RelationsSection({
  relations,
  lang,
  dict,
}: {
  relations: DetailRelation[];
  lang: Lang;
  dict: Dict;
}) {
  if (!relations.length) return null;
  const sorted = [...relations].sort((a, b) => {
    const ai = RELATION_ORDER.indexOf(a.relationType);
    const bi = RELATION_ORDER.indexOf(b.relationType);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <section style={{ margin: "32px 0" }}>
      <h2
        style={{
          fontFamily: "'Sora',sans-serif",
          fontSize: 16,
          fontWeight: 700,
          color: "#ffffff",
          marginBottom: 16,
        }}
      >
        {dict.detail.relations}
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
        }}
      >
        {sorted.map((rel) => {
          const label =
            relationLabel(rel.relationType, lang);
          // Cards mirror the inline hero chips — same helper, same
          // server-pinned zh, so likewise Chinese-first for everyone. Both
          // sites previously hardcoded romaji-wins and suppressed titleChinese
          // outright. Wire field is `title` not `titleRomaji`.
          const relTitle = pickRelatedTitle(rel, lang);
          return (
            <Link
              key={`${rel.anilistId}-${rel.relationType}`}
              href={`/anime/${rel.anilistId}`}
              prefetch={false}
              className="card-lift"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "#1c1c1e",
                border: "1px solid #38383a",
                borderRadius: 10,
                padding: 10,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              {rel.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <FadeImage
                  src={rel.coverImageUrl}
                  alt={relTitle}
                  width={48}
                  height={64}
                  style={{
                    width: 48,
                    height: 64,
                    objectFit: "cover",
                    borderRadius: 6,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 48,
                    height: 64,
                    borderRadius: 6,
                    flexShrink: 0,
                    background: "#2c2c2e",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    color: "rgba(235,235,245,0.30)",
                  }}
                >
                  N/A
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "inline-block",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#0a84ff",
                    textTransform: "uppercase",
                    marginBottom: 4,
                  }}
                >
                  {label}
                </span>
                <p
                  style={{
                    fontFamily: "'Sora',sans-serif",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#ffffff",
                    margin: 0,
                    lineHeight: 1.35,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {relTitle}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// --- Characters section ---

function CharactersSection({
  characters,
  lang,
  dict,
}: {
  characters: DetailCharacter[];
  lang: Lang;
  dict: Dict;
}) {
  if (!characters.length) return null;
  const label = dict.detail.characters;
  const jaLabel = dict.detail.voiceActorLang;

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{label}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: 8,
        }}
      >
        {characters.map((c, i) => {
          const roleKey = c.role?.toUpperCase() || "SUPPORTING";
          const roleLabel =
            CHARACTER_ROLE_LABEL[lang]?.[roleKey] ?? roleKey;
          // Field shape on the wire is {nameEn|nameJa|nameCn, voiceActor*}.
          // pickCharacterName picks lang-appropriate with fallback so a
          // missing nameCn surfaces nameJa instead of "—".
          const charName = pickCharacterName(c, lang) || "—";
          const va = pickVoiceActorName(c, lang) || null;
          return (
            <div
              key={`${charName}-${i}`}
              style={{
                display: "flex",
                alignItems: "stretch",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(84,84,88,0.30)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    width: 58,
                    height: 76,
                    flexShrink: 0,
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "#2c2c2e",
                    border: "1px solid #38383a",
                  }}
                >
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <FadeImage
                      src={c.imageUrl}
                      alt={charName}
                      width={58}
                      height={76}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : null}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#ffffff",
                      lineHeight: 1.35,
                      wordBreak: "break-word",
                    }}
                  >
                    {charName}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "rgba(235,235,245,0.40)",
                      marginTop: 3,
                    }}
                  >
                    {roleLabel}
                  </div>
                </div>
              </div>
              {va && (
                <>
                  <div
                    style={{
                      width: 1,
                      background: "rgba(84,84,88,0.30)",
                      flexShrink: 0,
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        width: 58,
                        height: 76,
                        flexShrink: 0,
                        borderRadius: 4,
                        overflow: "hidden",
                        background: "#2c2c2e",
                        border: "1px solid #38383a",
                      }}
                    >
                      {c.voiceActorImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <FadeImage
                          src={c.voiceActorImageUrl}
                          alt={va}
                          width={58}
                          height={76}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : null}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "#ffffff",
                          lineHeight: 1.35,
                          wordBreak: "break-word",
                        }}
                      >
                        {va}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "rgba(235,235,245,0.40)",
                          marginTop: 3,
                        }}
                      >
                        {jaLabel}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Staff section ---

function StaffSectionView({ staff, lang, dict }: { staff: DetailStaff[]; lang: Lang; dict: Dict }) {
  if (!staff.length) return null;
  const label = dict.detail.staff;

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{label}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "10px 16px",
        }}
      >
        {staff.map((s, i) => {
          // Wire shape is {nameEn, nameJa, role, imageUrl} — no top-level
          // `name`. pickStaffName: zh prefers Japanese (legacy convention),
          // en prefers English. Falls back across both before "—".
          const staffName = pickStaffName(s, lang) || "—";
          return (
          <div
            key={`${staffName}-${i}`}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                flexShrink: 0,
                overflow: "hidden",
                background: "#2c2c2e",
                border: "1px solid #38383a",
              }}
            >
              {s.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <FadeImage
                  src={s.imageUrl}
                  alt={staffName}
                  width={36}
                  height={36}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : null}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#ffffff",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {staffName}
              </div>
              {s.role && (
                <div
                  style={{
                    fontSize: 11,
                    color: "rgba(235,235,245,0.40)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {/* Server-rendered, unlike the hero genre/format chips: this
                      grid runs to dozens of rows, and the name beside each role
                      is already Japanese for every visitor (pickStaffName under
                      the pinned zh), so a client leaf per row would repaint one
                      column of a block that stays non-English either way. See
                      the route note at the top of this file. */}
                  {staffRoleLabel(s.role, lang)}
                </div>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Recommendations section ---

function RecommendationsSection({
  recommendations,
  lang,
  dict,
}: {
  recommendations: DetailRecommendation[];
  lang: Lang;
  dict: Dict;
}) {
  if (!recommendations.length) return null;
  const label = dict.detail.recommendations;
  // Legacy shows up to ~10 in a single horizontal-scroll strip with
  // 110×155 covers + title + score below (NOT the bento AnimeCard with
  // overlaid metadata). See client/src/components/anime/RecommendationSection.jsx.
  const items = recommendations.slice(0, 10);

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{label}</h2>
      <div
        style={{
          display: "flex",
          gap: 12,
          overflowX: "auto",
          paddingBottom: 8,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      >
        {items.map((r) => {
          // Wire field is `title` (romaji), not `titleRomaji`. Legacy
          // RecommendationSection.jsx pinned r.title, throwing away the Chinese
          // title on 79.1% of prod recommendation rows — the highest-yield
          // suppression on the page, which is why it is worth flipping even
          // though `lang` here is server-pinned zh for every visitor.
          const title = pickRelatedTitle(r, lang) || `Anime #${r.anilistId}`;
          return (
            <Link
              key={r.anilistId}
              href={`/anime/${r.anilistId}`}
              prefetch={false}
              className="card-lift"
              style={{
                flexShrink: 0,
                width: 110,
                color: "inherit",
                textDecoration: "none",
              }}
            >
              <div
                style={{
                  width: 110,
                  height: 155,
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "#2c2c2e",
                  marginBottom: 6,
                  border: "1px solid #38383a",
                }}
              >
                {r.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <FadeImage
                    src={r.coverImageUrl}
                    alt={title}
                    width={110}
                    height={155}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                ) : null}
              </div>
              <div
                title={title}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "rgba(235,235,245,0.75)",
                  lineHeight: 1.3,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {title}
              </div>
              {r.averageScore && r.averageScore > 0 ? (
                <div
                  style={{
                    fontSize: 11,
                    color: "#30d158",
                    marginTop: 3,
                  }}
                >
                  ★ {(r.averageScore / 10).toFixed(1)}
                </div>
              ) : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// --- Page entry ---

export default async function AnimeDetailPage({ params }: AnimeDetailPageProps) {
  // CF EDGE-CACHED ROUTE — keep this server render ANONYMOUS.
  // `/anime/*` is served from a Cloudflare edge cache (see
  // docs/migration/CF-EDGE-CACHE-PLAN.md). The cached HTML is handed to every
  // visitor, so do NOT read cookies()/headers()/searchParams or run any
  // per-user server fetch on this path: that either forces the page dynamic
  // (killing ISR) or caches one user's personalized HTML for everyone. Per-user
  // state hydrates client-side (auth_hint gate, see lib/clientAuth). If this
  // route ever must become per-user, update/remove the CF cache rule in the
  // same change.
  const { id } = await params;
  const anilistId = Number(id);
  if (!Number.isFinite(anilistId) || anilistId <= 0) notFound();

  const [{ dict, lang }, detail] = await Promise.all([
    resolveLocale(params),
    loadDetail(anilistId),
  ]);
  if (!detail) notFound();

  // ISSUE-001 now lives client-side: SubscriptionButton / EpisodesGrid read
  // the non-httpOnly `auth_hint` cookie on mount (see lib/clientAuth) and skip
  // their /api/subscriptions/:id probe when it's absent. That keeps this page
  // off cookies() so it can stay statically prerendered / ISR-cacheable.
  const jsonLd = buildJsonLd(detail, lang);

  return (
    <>
      {/* JSON-LD TVSeries: Google Rich Results gate for Phase 5 acceptance.
          dangerouslySetInnerHTML is safe here: jsonLd is built from typed
          AnimeDetail server fields, never from raw user input. We still
          guard against </script> sequences as defense in depth. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <main>
        <HeroAccent
          anilistId={detail.anilistId}
          coverImageUrl={detail.coverImageUrl}
          posterAccent={detail.posterAccent ?? null}
          posterAccentRgb={detail.posterAccentRgb ?? null}
        >
          <Hero detail={detail} lang={lang} dict={dict} />
        </HeroAccent>
        <div className="container">
          <DetailActions
            anilistId={detail.anilistId}
            episodes={detail.episodes}
            titleRomaji={detail.titleRomaji}
            titleEnglish={detail.titleEnglish}
            titleChinese={detail.titleChinese}
            titleNative={detail.titleNative}
            coverImageUrl={detail.coverImageUrl}
            shareTitle={pickTitle(detail, lang)}
            lang={lang}
            labels={{
              subAdd: dict.sub.addToList,
              subRemove: dict.sub.remove,
              subLogin: dict.sub.loginToWatch,
              subLoginAria: dict.sub.loginToWatch,
              subRate: dict.sub.rate,
              subEpUnit: dict.sub.epUnit,
              subWatching: dict.sub.watching,
              subCompleted: dict.sub.completed,
              subPlanToWatch: dict.sub.planToWatch,
              subDropped: dict.sub.dropped,
              share: dict.social.share,
              shareCopied: dict.detail.linkCopied,
              shareCopyFailed: dict.detail.linkCopyFailed,
              torrents: dict.torrent.download,
              torrentsTitle: dict.torrent.title,
              torrentsSearchBtn: dict.torrent.searchBtn,
              torrentsPlaceholder: dict.torrent.placeholder,
              torrentsGroupAll: dict.torrent.groupAll,
              torrentsEpAll: dict.torrent.epAll,
              torrentsLoading: dict.torrent.loading,
              torrentsNoResults: dict.torrent.noResults,
              torrentsClose: dict.torrent.close,
              torrentsCopy: dict.torrent.copy,
              torrentsCopied: dict.torrent.copied,
              torrentsOpenMagnet: dict.torrent.openMagnet,
              torrentsSeeders: dict.torrent.seeders,
              play: dict.detail.openPlayer,
              playAria: dict.detail.openPlayerAria,
            }}
          />
          <WatchersAvatarList anilistId={detail.anilistId} lang={lang} />
          <RelationsSection relations={detail.relations} lang={lang} dict={dict} />
          <CharactersSection characters={detail.characters} lang={lang} dict={dict} />
          <StaffSectionView staff={detail.staff} lang={lang} dict={dict} />
          <EpisodesGrid
            anilistId={detail.anilistId}
            episodes={detail.episodes}
            episodeTitles={detail.episodeTitles ?? []}
          />
          <RecommendationsSection
            recommendations={detail.recommendations}
            lang={lang}
            dict={dict}
          />
        </div>
      </main>
    </>
  );
}
