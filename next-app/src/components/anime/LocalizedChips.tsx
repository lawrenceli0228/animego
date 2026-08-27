"use client";

// Client leaves for the two most text-dense, most visible enum surfaces on
// the /anime/[id] detail page: the genre chip row and the format badge.
//
// Why client at all, on a page that is otherwise a pure RSC?
//
// Originally because getLang() returned "zh" unconditionally, so anything
// localised in place on that page rendered Chinese for every visitor. That is
// no longer true — the server resolves the language from the `[lang]` route
// segment now — but these two stay client-side for a second reason that
// outlived the first: useLang() follows the `lang` COOKIE, so a visitor whose
// preference is English still reads English chips on the bare (Chinese) URL
// they most likely arrived at from search. The prop would say "zh" there.
//
// That makes these a deliberate divergence from the rest of the page rather
// than a workaround. See the note beside SeasonalFilterChips in
// app/[lang]/seasonal/[season]/[year]/page.tsx — reconciling URL locale
// against cookie preference is one decision for the whole site.
//
// Genre text under en is byte-identical to before — genreLabel is the identity
// for en. The format badge is not: en now reads "Short"/"Movie"/"Special"
// instead of the raw "TV_SHORT"/"MOVIE"/"SPECIAL" enum the detail page used to
// print, matching the labels the seasonal filter has always shown. Deliberate,
// and the only place the en output moves.
//
// Cost is deliberately bounded: one instance per *row*, not per chip, so a
// 5-genre title hydrates two leaves total, and en visitors get a zh→en repaint
// at just these two spots. Everything else on the detail page stays
// server-rendered and therefore zh — see the route note at the top of
// app/anime/[id]/page.tsx for why the line is drawn here.

import { formatLabel, genreLabel } from "@/lib/contentLabels";
import { useLang } from "@/lib/lang-client";

// These take class names, not style objects. The caller (the detail page)
// used to hand over inline CSSProperties, which meant its chips could never
// grow a hover or a focus state — an inline declaration beats any stylesheet
// rule, so the CSS would have been written and then silently ignored.

interface GenreChipsProps {
  /** Raw AniList genre enums, e.g. ["Action", "Slice of Life"]. */
  genres: readonly string[];
  /** Class for the wrapping row. */
  className?: string;
  /** Class applied to every chip. */
  chipClassName?: string;
}

/**
 * Renders the whole genre row in a single client instance. The chip *text*
 * is localised; the underlying enum value is untouched, so nothing here
 * changes the values used in /search?genre= links elsewhere.
 */
export function GenreChips({ genres, className, chipClassName }: GenreChipsProps) {
  const { lang } = useLang();
  if (!genres.length) return null;
  return (
    <div className={className}>
      {genres.map((g) => (
        <span key={g} className={chipClassName}>
          {genreLabel(g, lang)}
        </span>
      ))}
    </div>
  );
}

interface FormatBadgeProps {
  /** Raw AniList format enum, e.g. "TV_SHORT". */
  format: string;
  className?: string;
}

/** Hero format badge — "TV_SHORT" → "TV 短篇" (zh) / "Short" (en). */
export function FormatBadge({ format, className }: FormatBadgeProps) {
  const { lang } = useLang();
  if (!format) return null;
  return <span className={className}>{formatLabel(format, lang)}</span>;
}
