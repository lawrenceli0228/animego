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
import type { ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import { notFound } from "next/navigation";
import { buildBreadcrumbJsonLd, buildJsonLd } from "@/components/anime/animeJsonLd";
import { DETAIL_CHARACTERS_SHOWN, DETAIL_STAFF_SHOWN } from "@/components/anime/detailPeople";
import DescriptionExpand from "@/components/anime/DescriptionExpand";
import FadeImage from "@/components/ui/FadeImage";
import EpisodesGrid from "@/components/anime/EpisodesGrid";
import { scoreScrimStyle } from "@/components/anime/scoreStyle";
import WatchersAvatarList from "@/components/anime/WatchersAvatarList";
import TrailerPreview from "@/components/anime/TrailerPreview";
// The sections below the hero. The hero itself, the tab bar and the frame
// around them are shared with the 角色 and 制作 tabs and live in _detail/ —
// see DetailShell.tsx.
import x from "./sections.module.css";
import DetailShell, { detailTrailerLabels } from "./_detail/DetailShell";
import {
  detailStaticParams,
  loadCommunityCount,
  loadCreditCountsSoft,
  loadDetail,
  parseAnimeId,
} from "./_detail/detailData";
import { seasonLabel, statusLabel } from "./_detail/detailLabels";
import { characterRoleLabel } from "@/lib/detail/cast";
import { detailTabHref } from "@/lib/detail/tabs";
import { characterPath, personPath } from "@/lib/people/paths";
import {
  durationLabel,
  formatLabel,
  pickRelatedTitle,
  relationLabel,
  sourceLabel,
  staffRoleLabel,
} from "@/lib/contentLabels";
import {
  formatFuzzyDate,
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
import { buildAlternates } from "@/lib/seo/alternates";
import { studioPath } from "@/lib/hubs/paths";
import { BCP47_TAG, OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { asYouTubeTrailer } from "@/lib/youtubeTrailer";
import { fill, type Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import type {
  AnimeDetail,
  CreditCounts,
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
// The result is the full LOCALES × ids product, and it has to be built by the
// route rather than left to the root layout's localeParams(); the 角色 and 制作
// tabs prerender the same set, so detailStaticParams builds it for all three
// (_detail/detailData.ts). A route with its own
// generateStaticParams supplies EVERY param in its path, `lang` included; a
// list of bare `{ id }` would not name the locale segment at all. Returning
// half the product does not fail the build or the ISR gate — it silently
// prerenders one locale and leaves the other to render on demand, which is
// invisible in the route table and in assert-isr.mjs alike.
export async function generateStaticParams(): Promise<
  Array<{ lang: string; id: string }>
> {
  return detailStaticParams();
}

type AnimeDetailPageProps = PageProps<"/[lang]/anime/[id]">;

// --- Detail fetch helper ---
//
// loadDetail lives in _detail/detailData.ts with the other reads the tabs
// share; generateMetadata and the page both call it and Next memoizes the
// fetch within the request.

// --- Labels ---
//
// The status and season labels the hero shares with the information table
// are in _detail/detailLabels.ts; the character roles, which the 角色 tab
// prints too, in lib/detail/cast.ts.

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

// scoreColor lived here and shipped a bug: it returned one of three band
// colours while S.scoreBadge hardcoded an amber background, so every anime
// rated 75+ rendered green text on an amber pill. It now lives in
// @/components/anime/scoreStyle, which returns the two together and can be
// imported by a test — this file cannot. See that module's header.

// --- generateMetadata: title / description / OG / Twitter / canonical ---

export async function generateMetadata({
  params,
}: AnimeDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = parseAnimeId(id);
  if (anilistId === null) {
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
//
// Lives in @/components/anime/animeJsonLd so a test can execute it: nothing
// can import this page (it reaches react-hot-toast, which touches `document`
// at module scope), and the numberOfEpisodes rule in there is worth a real
// assertion rather than a grep. See that file's header.

// --- Styles ---
//
// The hero's are in _detail/DetailHero.module.css (page.module.css until
// the tabs needed the same hero), not in an object here. The hero was 19
// inline CSSProperties literals, and inline styles have two properties that
// made that a dead end: they cannot express a hover, a focus ring or a media
// query, and they beat every stylesheet rule, so CSS written against these
// elements would have been silently inert.
//
// The geometry in particular had to move. Four values — banner height, how
// far the content is pulled up into it, the poster width, and the title's
// top offset — are one design, and they were four separate ternaries on
// `detail.bannerImageUrl` spread over 70 lines of JSX. They are now one
// custom-property set per state and this file only declares which state it
// is in, via data-banner. See the header of _detail/DetailHero.module.css.

// --- Synopsis ---

// Collapsed-description budget, in "latin character" units — CJK counts two.
// Measuring width rather than characters keeps the collapsed block the same
// apparent size in both scripts. With a plain character count the Chinese
// summaries all sat under the threshold (55-289 chars) while their English
// counterparts ran well over it (235-1100), so the read-more control appeared
// only for English readers and Chinese readers got the whole synopsis dumped
// into the hero.
const DESC_TRUNCATE_WIDTH = 300;

// --- Relations section ---

// --- Intrinsic sizes for the images in these four sections ---
//
// These are next/image's srcset basis, NOT the CSS box: the layout lives in
// sections.module.css and the tiles are fluid. Next derives a 1x/2x pair from
// `width`, so the number has to be at least the widest the tile ever renders
// or every cover is upscaled on a retina screen — which is exactly what the
// old width={110} did to a 110px tile the moment anything grew it.
//
// Poster: 7:10, matching the hero cover. AniList's large covers are 460x650,
// so 7:10 crops almost nothing (page.module.css says the same thing about
// `.cover`). 160 is the widest a `.posterGrid` track gets — 192px at a 400px
// viewport, where the 2x candidate Next emits (384w) still covers it.
const POSTER_SRC_W = 160;
const POSTER_SRC_H = 229;
// Character / voice-actor portraits. Enlarged from 58x76 — see the note on
// `.people` in sections.module.css for why the grid track had to widen with
// them rather than after them.
const PORTRAIT_W = 64;
const PORTRAIT_H = 86;
// Staff avatar, up from 36. A 36px circle beside a name reads as a bullet.
const STAFF_AVATAR = 44;


/* The complete record, as a definition list.
 *
 * This is where format, season, studio, source and the air date went when
 * the facts line in the hero was cut back to six items. They are not less
 * important — they are less *glanceable*, and a dot-separated sentence is a
 * bad container for eight label/value pairs: without labels the reader has
 * to infer that "TV" is a format and "MADHOUSE" is a studio, and with them
 * the sentence stops being a sentence.
 *
 * <dl> rather than a grid of divs because that is exactly what this is, and
 * it is what lets a screen reader announce "季度: 2023 年秋季" as a pair.
 * Rows with no value still render, with an em dash: an absent field is
 * itself information here, and a table that changes shape per anime is
 * harder to scan across pages than one with a hole in it.
 *
 * Eight cells and nothing else, by decision. The 0036/0038 data (aliases,
 * production committee, tags, external links) was drawn here as wide rows
 * for a day and taken out: on a Chinese page the aliases were a Thai and a
 * Russian title, the committee is a list of broadcasters, the tags are
 * English, and the links duplicate what the hero and the score panel
 * already say. The data stays in the DTO and in JSON-LD (sameAs is the
 * disambiguation signal, not page content); detailFacts.ts still knows how
 * to pick a readable subset when a surface for it is decided.
 */
function InfoSection({
  detail,
  lang,
  dict,
}: {
  detail: AnimeDetail;
  lang: Lang;
  dict: Dict;
}) {
  const seasonLab = seasonLabel(dict, detail.season);
  const rows: Array<{ label: string; value: string | null; node?: ReactNode }> = [
    {
      label: dict.detail.infoSeason,
      value: seasonLab && detail.seasonYear ? `${seasonLab} ${detail.seasonYear}` : null,
    },
    { label: dict.detail.infoAired, value: formatFuzzyDate(detail.startDate, lang) || null },
    { label: dict.detail.infoStatus, value: detail.status ? statusLabel(dict, detail.status) : null },
    {
      label: dict.detail.infoEpisodes,
      value: detail.episodes ? `${detail.episodes} ${dict.detail.epUnit}` : null,
    },
    { label: dict.detail.infoDuration, value: durationLabel(detail.duration, lang) || null },
    {
      label: dict.detail.infoFormat,
      // formatLabel, not the raw enum: the table would otherwise print
      // "TV_SHORT" where every other row is prose.
      value: detail.format ? formatLabel(detail.format, lang) : null,
    },
    { label: dict.detail.infoSource, value: sourceLabel(detail.source, lang) || null },
    {
      label: dict.detail.infoStudio,
      value: detail.studios.length > 0 ? detail.studios.join(" / ") : null,
      // The studio names link to their hub pages; the plain `value` stays
      // for the "every row empty" check and as the text fallback.
      node:
        detail.studios.length > 0 ? (
          <span className={x.infoLinks}>
            {detail.studios.map((name, i) => (
              <span key={name}>
                {i > 0 ? " / " : ""}
                <Link href={studioPath(name)} className={x.infoLink} prefetch={false}>
                  {name}
                </Link>
              </span>
            ))}
          </span>
        ) : null,
    },
  ];
  // Every row empty means the row carries nothing but em dashes.
  if (rows.every((r) => !r.value)) return null;

  return (
    <section className={x.section} aria-labelledby="info-heading">
      <header className={x.head}>
        <h2 className={x.headTitle} id="info-heading">
          {dict.detail.info}
        </h2>
      </header>
      <dl className={x.infoGrid}>
        {rows.map((r) => (
          <div key={r.label} className={x.infoCell}>
            <dt className={x.infoLabel}>{r.label}</dt>
            <dd className={x.infoValue}>{r.node ?? r.value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* Synopsis — its own band under the hero, no longer inside it.
 *
 * The hero is now artwork with the title and the controls on it, and the
 * body copy does not belong on top of a picture: it is the longest text on
 * the page and the one thing a search visitor actually came to read. Giving
 * it a plain background is what lets the artwork above be full-bleed.
 *
 * The scores ride alongside rather than in the facts sentence, because a
 * number out of 100 next to a number out of 10 needs its denominator shown
 * to be read at all, and denominators do not belong in a dot-separated
 * list.
 */
function SynopsisSection({
  detail,
  lang,
  dict,
  trailer,
}: {
  detail: AnimeDetail;
  lang: Lang;
  dict: Dict;
  trailer?: ReactNode;
}) {
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
  const score = detail.averageScore;
  const bgmScore = detail.bangumiScore;
  const popularity = detail.popularity && detail.popularity > 0 ? detail.popularity : null;
  if (!descFull) return null;

  return (
    <section
      className={x.synopsis}
      aria-labelledby="synopsis-heading"
      data-has-trailer={trailer ? "true" : "false"}
    >
      <div className={x.synopsisSummary}>
        <div className={x.synopsisBody}>
          <header className={x.head}>
            <h2 className={x.headTitle} id="synopsis-heading">
              {dict.detail.synopsis}
            </h2>
            {/* Length, not a count of anything the reader cares about on its
                own — it sets the expectation before the read-more toggle, so
                "展开更多" is a known quantity rather than a surprise. Measured
                on the full text, not the collapsed mirror. */}
            {descFull ? (
              <span className={x.headCount}>
                {descFull.length} {dict.detail.charUnit}
              </span>
            ) : null}
          </header>
          {/* Description with 展开更多 / 收起 toggle */}
          {descFull && (
            <div className={x.descBlock}>
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
        </div>
        {(score && score > 0) || (bgmScore && bgmScore > 0) || popularity ? (
          <aside className={x.scorePanel} aria-label={dict.detail.scores}>
            {(score && score > 0) || popularity ? (
              <div className={x.scoreItem}>
                <div className={x.scoreLabel}>AniList</div>
                {score && score > 0 ? (
                  <div className={x.scoreValueAccent}>
                    {score}
                    <span className={x.scoreDenom}>/ 100</span>
                  </div>
                ) : null}
                {/* How many AniList users have it on a list — the count the
                    score above lacks (AniList publishes no vote count, which
                    is why it cannot be an AggregateRating). A title that is
                    not out yet has this and no score, and the panel still
                    has something true to say about it. */}
                {popularity ? (
                  <div className={x.scoreVotes}>
                    {fill(dict.detail.popularity, { n: popularity.toLocaleString(BCP47_TAG[lang]) })}
                  </div>
                ) : null}
                {/* aria-hidden: the number above already says it, and a
                    progress bar with no label is noise in a screen reader. */}
                {score && score > 0 ? (
                  <div className={x.scoreBar} aria-hidden>
                    <span style={{ width: `${score}%` }} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {bgmScore && bgmScore > 0 ? (
              <div className={x.scoreItemBangumi}>
                <div className={x.scoreLabel}>Bangumi</div>
                <div className={x.scoreValue}>
                  {bgmScore.toFixed(1)}
                  <span className={x.scoreDenom}>/ 10</span>
                </div>
                {detail.bangumiVotes && detail.bangumiVotes > 0 ? (
                  <div className={x.scoreVotes}>
                    {detail.bangumiVotes.toLocaleString()} {dict.detail.votes}
                  </div>
                ) : null}
                <div className={x.scoreBar} aria-hidden>
                  <span style={{ width: `${bgmScore * 10}%` }} />
                </div>
              </div>
            ) : null}
            {/* Who else is watching, under the scores.
                It used to sit alone at the bottom of the page, below the
                recommendations, where it read as a footer rather than as part
                of what this anime is. Here it closes the same group the
                scores open — both are "what other people did with this show". */}
            <div className={x.synopsisWatchers}>
              <WatchersAvatarList anilistId={detail.anilistId} lang={lang} />
            </div>
          </aside>
        ) : (
          // No scores: the watcher strip still belongs in the summary group.
          <aside className={x.scorePanel}>
            <div className={x.synopsisWatchers}>
              <WatchersAvatarList anilistId={detail.anilistId} lang={lang} />
            </div>
          </aside>
        )}
      </div>
      {trailer ? (
        <aside
          className={x.synopsisTrailer}
          aria-labelledby="synopsis-trailer-heading"
        >
          <header className={x.synopsisTrailerHead}>
            <h2
              className={x.synopsisTrailerTitle}
              id="synopsis-trailer-heading"
            >
              <span className={x.synopsisTrailerMark} aria-hidden />
              {dict.detail.officialTrailer}
            </h2>
            <span className={x.synopsisTrailerSource}>YouTube</span>
          </header>
          {trailer}
        </aside>
      ) : null}
    </section>
  );
}

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
    <section className={x.section}>
      <header className={x.head}>
        <h2 className={x.headTitle}>{dict.detail.relations}</h2>
        <span className={x.headCount}>{sorted.length}</span>
      </header>
      <div className={x.posterGrid}>
        {sorted.map((rel) => {
          const label = relationLabel(rel.relationType, lang);
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
              // .card-lift is the global reduced-motion-guarded hover lift
              // (globals.css); the module adds the glow and the image scale,
              // which it cannot express, and deliberately does not add a
              // second transform on top of it.
              className={`card-lift ${x.posterCard}`}
            >
              <div className={x.posterFrame}>
                {rel.coverImageUrl ? (
                  <FadeImage
                    src={rel.coverImageUrl}
                    alt={relTitle}
                    width={POSTER_SRC_W}
                    height={POSTER_SRC_H}
                    className={x.posterImg}
                  />
                ) : (
                  <span className={x.posterEmpty}>N/A</span>
                )}
                <span className={x.relBadge}>{label}</span>
              </div>
              <p className={x.posterTitle}>{relTitle}</p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// --- Characters section ---

// How many people each section lays out lives in detailPeople.ts, shared
// with the JSON-LD so the cast it names is the cast the reader can see.

/** The chevron after a 「全部」 link — the design's, drawn in currentColor. */
function MoreChevron() {
  return (
    <svg className={x.headMoreIcon} viewBox="0 0 24 24" aria-hidden>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CharactersSection({
  anilistId,
  characters: allCharacters,
  counts,
  lang,
  dict,
}: {
  anilistId: number;
  characters: DetailCharacter[];
  counts: CreditCounts | null;
  lang: Lang;
  dict: Dict;
}) {
  const characters = allCharacters.slice(0, DETAIL_CHARACTERS_SHOWN);
  if (!characters.length) return null;
  const label = dict.detail.characters;
  const jaLabel = dict.detail.voiceActorLang;
  // To the 角色 tab, which lists them all with every voice. Named with the
  // number when the count arrived; the tab is there either way.
  const allHref = detailTabHref(anilistId, "characters");
  const allLabel = counts
    ? fill(dict.detail.allCharacters, { n: counts.characters })
    : dict.detail.allCharactersPlain;

  return (
    <section className={x.section}>
      <header className={x.head}>
        <h2 className={x.headTitle}>{label}</h2>
        <span className={x.headCount}>{characters.length}</span>
        <Link href={allHref} className={x.headMoreWide} prefetch={false}>
          {allLabel}
          <MoreChevron />
        </Link>
      </header>
      <div className={x.people}>
        {characters.map((c, i) => {
          const roleLabel = characterRoleLabel(c.role, lang);
          // Field shape on the wire is {nameEn|nameJa|nameCn, voiceActor*}.
          // pickCharacterName picks lang-appropriate with fallback so a
          // missing nameCn surfaces nameJa instead of "—".
          const charName = pickCharacterName(c, lang) || "—";
          const va = pickVoiceActorName(c, lang) || null;
          return (
            // The row is a row, not a card: no border, no fill. What tells
            // one from the next is a hairline and the hover surface, both of
            // which live in the module because neither can be an inline style.
            <div key={`${charName}-${i}`} className={x.person}>
              {/* Each side opens its own page — the character's, the voice
                  actor's — as the design's two links per row. A row written
                  before AniList ids were stored has no id and stays text. */}
              <PersonSide
                href={c.characterId != null ? characterPath(c.characterId) : null}
                className={x.personSide}
              >
                {/* No null guard: FadeImage renders the same box with the
                    same class when src is null, so a character with no
                    portrait keeps the row's shape instead of collapsing it. */}
                <FadeImage
                  src={c.imageUrl}
                  alt={charName}
                  width={PORTRAIT_W}
                  height={PORTRAIT_H}
                  className={x.portrait}
                />
                <div className={x.personText}>
                  <div className={x.personRoleMain}>{roleLabel}</div>
                  <div className={x.personName}>{charName}</div>
                </div>
              </PersonSide>
              {va && (
                <PersonSide
                  href={c.voiceActorId != null ? personPath(c.voiceActorId) : null}
                  className={x.personSideVa}
                >
                  <FadeImage
                    src={c.voiceActorImageUrl}
                    alt={va}
                    width={PORTRAIT_W}
                    height={PORTRAIT_H}
                    className={x.portrait}
                  />
                  <div className={x.personText}>
                    <div className={x.personRole}>{jaLabel}</div>
                    <div className={x.personName}>{va}</div>
                  </div>
                </PersonSide>
              )}
            </div>
          );
        })}
      </div>
      {/* On a phone the link moves under the list, full width, where the
          thumb is after eight rows — the design's phone board. One of the
          two is display:none at any width. */}
      <Link href={allHref} className={x.moreBlock} prefetch={false}>
        {allLabel}
      </Link>
    </section>
  );
}

/** A link to a person's or character's page, or a plain box when there is none. */
function PersonSide({ href, className, children }: { href: string | null; className: string; children: ReactNode }) {
  return href ? (
    <Link href={href} className={className} prefetch={false}>
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  );
}

// --- Staff section ---

function StaffSectionView({
  anilistId,
  staff: allStaff,
  counts,
  lang,
  dict,
}: {
  anilistId: number;
  staff: DetailStaff[];
  counts: CreditCounts | null;
  lang: Lang;
  dict: Dict;
}) {
  const staff = allStaff.slice(0, DETAIL_STAFF_SHOWN);
  if (!staff.length) return null;
  const label = dict.detail.staff;

  return (
    <section className={x.section}>
      <header className={x.head}>
        <h2 className={x.headTitle}>{label}</h2>
        <span className={x.headCount}>{staff.length}</span>
        <Link href={detailTabHref(anilistId, "staff")} className={x.headMore} prefetch={false}>
          {counts ? fill(dict.detail.allStaff, { n: counts.staff }) : dict.detail.allStaffPlain}
          <MoreChevron />
        </Link>
      </header>
      <div className={x.staffGrid}>
        {/* `member`, not `s`. The callback parameter used to be named `s`,
            which shadowed the page.module.css import of the same name for the
            whole body — so no class from that module was reachable in here
            and `s.role` read as a staff field one line after `s.sectionLabel`
            read as a class. */}
        {staff.map((member, i) => {
          // Wire shape is {nameEn, nameJa, role, imageUrl} — no top-level
          // `name`. pickStaffName: zh prefers Japanese (legacy convention),
          // en prefers English. Falls back across both before "—".
          const staffName = pickStaffName(member, lang) || "—";
          return (
            <PersonSide
              key={`${staffName}-${i}`}
              href={member.staffId != null ? personPath(member.staffId) : null}
              className={x.staffRow}
            >
              <FadeImage
                src={member.imageUrl}
                alt={staffName}
                width={STAFF_AVATAR}
                height={STAFF_AVATAR}
                className={x.staffAvatar}
              />
              <div className={x.staffText}>
                {member.role && (
                  <div className={x.staffRole}>
                    {/* Server-rendered, unlike the hero genre/format chips: this
                        grid runs to dozens of rows, and the name beside each role
                        is already Japanese for every visitor (pickStaffName under
                        the pinned zh), so a client leaf per row would repaint one
                        column of a block that stays non-English either way. See
                        the route note at the top of this file. */}
                    {staffRoleLabel(member.role, lang)}
                  </div>
                )}
                <div className={x.staffName}>{staffName}</div>
              </div>
            </PersonSide>
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
    <section className={x.sectionLast}>
      <header className={x.head}>
        <h2 className={x.headTitle}>{label}</h2>
        <span className={x.headCount}>{items.length}</span>
      </header>
      <div className={x.recStrip}>
        {items.map((r) => {
          // Wire field is `title` (romaji), not `titleRomaji`. Legacy
          // RecommendationSection.jsx pinned r.title, throwing away the Chinese
          // title on 79.1% of prod recommendation rows — the highest-yield
          // suppression on the page, which is why it is worth flipping even
          // though `lang` here is server-pinned zh for every visitor.
          const title = pickRelatedTitle(r, lang) || `Anime #${r.anilistId}`;
          const score = r.averageScore && r.averageScore > 0 ? r.averageScore : null;
          return (
            <Link
              key={r.anilistId}
              href={`/anime/${r.anilistId}`}
              prefetch={false}
              className={`card-lift ${x.recCard}`}
            >
              <div className={x.posterFrame}>
                {r.coverImageUrl ? (
                  <FadeImage
                    src={r.coverImageUrl}
                    alt={title}
                    width={POSTER_SRC_W}
                    height={POSTER_SRC_H}
                    className={x.posterImg}
                  />
                ) : null}
                {score !== null ? (
                  // On the artwork now, and banded rather than always green.
                  // It was a hardcoded #30d158 under the title, so a 55-rated
                  // recommendation was painted the same "good" green as a 90 —
                  // the exact split scoreStyle.ts exists to make impossible.
                  // scoreScrimStyle returns background and foreground together.
                  <span className={x.recScore} style={scoreScrimStyle(score)}>
                    ★ {(score / 10).toFixed(1)}
                  </span>
                ) : null}
              </div>
              <p className={x.posterTitle} title={title}>
                {title}
              </p>
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
  const anilistId = parseAnimeId(id);
  if (anilistId === null) notFound();

  const [{ dict, lang }, detail] = await Promise.all([
    resolveLocale(params),
    loadDetail(anilistId),
  ]);
  if (!detail) notFound();
  // After the detail, not beside it: for a title only a listing has written,
  // the detail fetch is what fills the credit tables, and counts read in
  // parallel would be the zeros from before (see detailData.ts `snapshot`).
  // For the tab bar and the 「全部」 links only — a page that could not get
  // them still renders, with neither number. The community count waits for
  // the detail too: for a title the catalogue did not hold, the detail fetch
  // is what adds it, and before that the count is a 404.
  const [counts, communityCount] = await Promise.all([
    loadCreditCountsSoft(anilistId, detail.cachedAt),
    loadCommunityCount(anilistId),
  ]);

  // ISSUE-001 now lives client-side: SubscriptionButton / EpisodesGrid read
  // the non-httpOnly `auth_hint` cookie on mount (see lib/clientAuth) and skip
  // their /api/subscriptions/:id probe when it's absent. That keeps this page
  // off cookies() so it can stay statically prerendered / ISR-cacheable.
  const jsonLd = buildJsonLd(detail, lang);
  const breadcrumbLd = buildBreadcrumbJsonLd(detail, lang, dict.nav.home);
  const displayTitle = pickTitle(detail, lang);
  const trailer = asYouTubeTrailer(detail.trailer);

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
      {/* BreadcrumbList: home › the hub this title hangs under › the title.
          A second document rather than a @graph so the TVSeries keeps the
          shape its tests pin. Same escaping, same provenance. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbLd).replace(/</g, "\\u003c"),
        }}
      />
      <DetailShell
        detail={detail}
        lang={lang}
        dict={dict}
        active="overview"
        counts={{ characters: counts?.characters, staff: counts?.staff, social: communityCount }}
      >
        {/* Order follows the demo: read about it, look it up, then use
            it. Episodes sit third rather than sixth because they are the
            one thing a returning visitor came for, and relations move
            near the bottom because they are navigation away from this
            page — putting them second sent people off it before they had
            seen anything. */}
        <SynopsisSection
          detail={detail}
          lang={lang}
          dict={dict}
          trailer={
            trailer ? (
              <TrailerPreview
                trailerId={trailer.id}
                title={displayTitle}
                labels={detailTrailerLabels(dict)}
                variant="card"
              />
            ) : undefined
          }
        />
        <InfoSection detail={detail} lang={lang} dict={dict} />
        <EpisodesGrid
          anilistId={detail.anilistId}
          episodes={detail.episodes}
          episodesBgm={detail.episodesBgm ?? null}
          episodeTitles={detail.episodeTitles ?? []}
        />
        <CharactersSection
          anilistId={detail.anilistId}
          characters={detail.characters}
          counts={counts}
          lang={lang}
          dict={dict}
        />
        <StaffSectionView
          anilistId={detail.anilistId}
          staff={detail.staff}
          counts={counts}
          lang={lang}
          dict={dict}
        />
        <RelationsSection relations={detail.relations} lang={lang} dict={dict} />
        <RecommendationsSection
          recommendations={detail.recommendations}
          lang={lang}
          dict={dict}
        />
      </DetailShell>
    </>
  );
}
