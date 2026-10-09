// The detail page's hero — banner, poster, title, facts and the action row —
// shared by every /anime/[id] tab.
//
// Moved here unchanged from the overview page when the page grew tabs: the
// overview, 角色 and 制作 all open with the same hero (the approved design
// draws it on every desktop board), so it is one component rather than three
// copies. Its stylesheet came with it; see that file's header for the
// geometry, and the end of it for the compact phone form the two list tabs
// use.

import type { ReactNode } from "react";
import Image from "next/image";
import NextAiringBadge from "@/components/anime/NextAiringBadge";
import FadeImage from "@/components/ui/FadeImage";
import { resolveEpisodeSkeleton } from "@/components/anime/episodeGridSkeleton";
import { GenreChips } from "@/components/anime/LocalizedChips";
import { durationLabel } from "@/lib/contentLabels";
import { pickTitle } from "@/lib/formatters";
import { BCP47_TAG, type Lang } from "@/lib/i18n/lang";
import type { Dict } from "@/lib/i18n";
import type { AnimeDetail } from "@/lib/types";
import { statusLabel } from "./detailLabels";
import s from "./DetailHero.module.css";

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

/**
 * The next episode if it is still ahead of the server clock, else null.
 *
 * `nextAiring` is as fresh as the row (a detail read or the hourly facts
 * sweep), so on a page rendered a day after the episode aired it names an
 * episode that is already out. Not rendering it at all is the honest
 * answer; the badge does the same check again on the client, against the
 * reader's clock, because the ISR copy this decision was made on can be
 * hours old by the time it is read.
 */
function upcomingEpisode(
  next: AnimeDetail["nextAiring"],
): { airingAt: string; episode: number } | null {
  if (!next?.airingAt || !next.episode) return null;
  const at = Date.parse(next.airingAt);
  if (!Number.isFinite(at) || at <= Date.now()) return null;
  return { airingAt: next.airingAt, episode: next.episode };
}

export default function DetailHero({
  detail,
  lang,
  dict,
  actions,
  compact = false,
}: {
  detail: AnimeDetail;
  lang: Lang;
  dict: Dict;
  /* The action row, injected rather than rendered here. It is a client
   * component and this file is not; passing it as a node keeps the hero a
   * server component while letting the controls sit where the design puts
   * them — directly under the facts, on the artwork. */
  actions?: ReactNode;
  /* The 角色 and 制作 tabs. On a phone their hero folds to one line — the
   * poster and the title — so the list starts on the first screen; on a
   * wider screen it is the full hero every tab shares. CSS only (see the end
   * of DetailHero.module.css): the markup, the h1 and the actions are the
   * same on every tab. */
  compact?: boolean;
}) {
  const title = pickTitle(detail, lang);
  const durationText = durationLabel(detail.duration, lang);
  const score = detail.averageScore;
  // Shared with EpisodesGrid below the fold, so the badge and the grid can
  // never disagree about whether this show's episode count is known.
  //
  // Both counts go in, and they go in through separate parameters. `episodes`
  // is AniList's authoritative total; `episodesBgm` is the sweep's inference
  // for the rows AniList leaves NULL. Passing the second one in as the first
  // would size the grid correctly and then label the result `authoritative`,
  // which is the same merge the schema refuses to do in SQL, just relocated
  // into a discriminant.
  //
  // Only the `authoritative` case prints a number in the badge. `inferred` is
  // a lower bound — a possibly-stale external total, or however many episode
  // titles we happen to hold — and printing one next to the studio and the
  // season would present it as the total, on a page Google indexes, in the
  // same badge row that carries the score. buildJsonLd draws the harder line
  // one layer up: numberOfEpisodes reads detail.episodes and nothing else, so
  // an inferred count can size this grid but can never become a claim about
  // the work. See animeJsonLd.ts.
  const episodeSkeleton = resolveEpisodeSkeleton(
    detail.episodes,
    detail.episodesBgm ?? null,
    detail.episodeTitles ?? [],
  );
  const nextAiring = upcomingEpisode(detail.nextAiring);

  return (
    // data-banner is the whole conditional. Every geometry value that used to
    // be a `detail.bannerImageUrl ? a : b` in the JSX below now hangs off this
    // one attribute in page.module.css, so the four of them cannot be changed
    // apart from each other.
    <div
      className={s.hero}
      data-banner={detail.bannerImageUrl ? "true" : "false"}
      data-compact={compact ? "true" : undefined}
    >
      {/* Banner — a real <img>, not a CSS background.
        *
        * This is the LCP element of the page Google indexes, and as
        * `background: url(...)` the preload scanner could not see it: that
        * scanner only reads tag attributes off the raw HTML byte stream, so a
        * URL that only exists inside a style declaration is not discoverable
        * until the CSSOM is built and the box is laid out. Measured in prod at
        * 198 KB with no preload of any kind, while the one image preload the
        * page did emit pointed at the 210x300 cover below it.
        *
        * Switching to <img loading="eager" fetchPriority="high"> fixes both
        * halves at once: the scanner finds it in the first pass, and React 19
        * hoists a matching <link rel="preload" as="image"> for it (that is
        * where the cover's existing preload comes from — there is no explicit
        * preload call anywhere in this repo).
        *
        * Pixel-identical to the old rule: `center/cover` is exactly
        * `object-fit: cover` + `object-position: center`, and inset-0 on a
        * `position: relative` parent reproduces the painting box a background
        * had. The overlay stays after it in DOM order so it still stacks on
        * top. Decorative, so alt="" and hidden from the a11y tree — the title
        * is rendered as text a few lines below.
        *
        * No width/height attributes on purpose: the element is absolutely
        * positioned into a fixed-height box, so there is no layout to reserve
        * and the intrinsic ratio would only be a lie if AniList ever changes
        * banner dimensions. */}
      <div className={s.banner}>
        {detail.bannerImageUrl ? (
          <Image
            src={detail.bannerImageUrl}
            alt=""
            aria-hidden
            // AniList banners are 1900x400. `sizes="100vw"` is honest -- the
            // box is full-bleed at every width -- and it is affordable here
            // because the page renders exactly one of these.
            width={1900}
            height={400}
            quality={85}
            sizes="100vw"
            loading="eager"
            fetchPriority="high"
            decoding="sync"
            className={s.bannerImage}
          />
        ) : null}
        <div className={s.bannerOverlay} />
      </div>

      {/* Content */}
      <div className={`container ${s.content}`}>
        {/* Cover — `hero-cover` class lets HeroAccent's halo CSS attach.
            Halo color comes from --poster-accent on the HeroAccent wrapper.
            The width/height attributes still carry the intrinsic ratio (they
            are what reserves the box before decode); the module sizes it. */}
        <div className={s.coverSlot}>
          {detail.coverImageUrl ? (
            <FadeImage
              src={detail.coverImageUrl}
              alt={title}
              width={210}
              height={300}
              priority
              className={`hero-cover ${s.cover}`}
            />
          ) : (
            <div className={s.coverPlaceholder} aria-hidden />
          )}
        </div>

        {/* Meta + actions. Kept in one column on larger screens; the wrapper
            becomes display:contents on phones so the action row can span
            beneath both the cover and the text instead of being squeezed
            into the narrow title column. */}
        <div className={s.metaColumn}>
          <div className={s.meta}>
            <h1 className={s.title}>{title}</h1>
          {SHOWS_ORIGINAL_SUBTITLE[lang] && (detail.titleNative || detail.titleRomaji) && (
            <p className={s.subtitle}>
              {detail.titleNative || detail.titleRomaji}
              {/* The romanisation beside the native title, not instead of it.
                  It is the string a reader types into a search box or matches
                  against a filename, and it is Latin by definition — the one
                  place on this page where a display face reads as typeset
                  rather than as unstyled. */}
              {detail.titleNative && detail.titleRomaji ? (
                <span className={s.subtitleRoman}>{detail.titleRomaji}</span>
              ) : null}
            </p>
          )}

          {/* Facts — one dot-separated sentence, was three stacked strips.
              Separators are drawn by CSS (.facts > * + *::before), so nothing
              here has to know whether it is the first surviving item across
              ten independently-optional fields. */}
          {/* Six items, not eleven.
              Format, season, studio, source and the Bangumi link all moved to
              the InfoSection table below. This line is the glance — is it good,
              is it finished, how long is it, what kind of thing is it — and
              every field added to it costs the ones already here their weight.
              The table is where the complete record belongs. */}
          <div className={s.facts}>
            {score && score > 0 ? (
              // "AniList 91", not "★ 9.1". The star said nothing the word
              // does not, and the raw 0-100 needs no mental conversion to
              // compare against the site it came from.
              //
              // The number carries the anime's colour, not a score band.
              // Band colours (green/amber/red) turn a score into a verdict,
              // and three of them in a row — AniList, Bangumi, and every
              // recommendation card — is three different judgements shouting
              // at a reader who has not decided to care yet. The band
              // mapping still exists and is still tested; it is used where a
              // verdict IS the point, on the recommendation covers.
              <span className={s.factsScore}>
                <span className={s.factsScoreLabel}>AniList</span> {score}
              </span>
            ) : null}
            {detail.bangumiScore && detail.bangumiScore > 0 ? (
              // The score IS the link. There used to be a separate "view on
              // Bangumi" item further along the row, which is a second thing
              // to read that says what this one already implies — and it sat
              // nowhere near the number it belonged to.
              //
              // Vote count lives in the score panel beside the synopsis,
              // where there is room to label it.
              detail.bgmId ? (
                <a
                  href={`https://bgm.tv/subject/${detail.bgmId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={s.factsBgmLink}
                  title={dict.detail.viewOnBgm}
                >
                  <span className={s.factsScoreLabel}>Bangumi</span>{" "}
                  {detail.bangumiScore.toFixed(1)}
                </a>
              ) : (
                <span className={s.factsBgm}>
                  <span className={s.factsScoreLabel}>Bangumi</span>{" "}
                  {detail.bangumiScore.toFixed(1)}
                </span>
              )
            ) : null}
            {detail.status && <span>{statusLabel(dict, detail.status)}</span>}
            {episodeSkeleton.kind === "authoritative" ? (
              <span>
                {episodeSkeleton.total} {dict.detail.epUnit}
              </span>
            ) : (
              // Muted rather than plain: this is the "we do not have an
              // authoritative count" case, and it should not read with the
              // same confidence as a real number sitting next to it.
              <span className={s.factsBgmVotes}>{dict.detail.episodeCountPending}</span>
            )}
            {durationText && <span>{durationText}</span>}
            {/* Genres — client leaf so this follows the cookie language rather
                than the server-pinned zh; see the route note at the top of this
                file for why only this and the format badge get that treatment.
                One instance for the whole row, not one per chip. Only the chip
                text is localised: buildJsonLd still emits detail.genres raw, so
                schema.org keeps the English AniList vocabulary. */}
            <GenreChips genres={detail.genres} className={s.factsGenres} />
          </div>

          {/* The next episode, for a title with one ahead of it. Decided here
              on the server clock only as far as "not already aired at render
              time"; the client leaf owns the countdown and hides itself once
              the instant passes (see NextAiringBadge). Also covers a premiere:
              AniList's nextAiringEpisode on a NOT_YET_RELEASED title is
              episode 1. */}
          {nextAiring ? (
            <NextAiringBadge
              airingAt={nextAiring.airingAt}
              episode={nextAiring.episode}
              bcp47={BCP47_TAG[lang]}
              copy={{
                nextEpisode: dict.detail.nextEpisode,
                airsInDays: dict.detail.airsInDays,
                airsInHours: dict.detail.airsInHours,
                airsInMinutes: dict.detail.airsInMinutes,
                airsSoon: dict.detail.airsSoon,
              }}
            />
          ) : null}

          </div>
          {actions ? <div className={s.actionSlot}>{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}
