"use client";

// Client leaves for the two most text-dense, most visible enum surfaces on
// the /anime/[id] detail page: the genre chip row and the format badge.
//
// Why client at all, on a page that is otherwise a pure RSC?
// getLang() on the server returns "zh" unconditionally (ISR islanding — see
// the comment in @/lib/i18n), so anything localised *in place* on that page
// renders Chinese for every visitor, English readers included. Reading the
// real language through useLang() (SSR-seeded zh, reconciled from the `lang`
// cookie after mount) is what lets these two surfaces stay English for en.
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

import type { CSSProperties } from "react";
import { formatLabel, genreLabel } from "@/lib/contentLabels";
import { useLang } from "@/lib/lang-client";

interface GenreChipsProps {
  /** Raw AniList genre enums, e.g. ["Action", "Slice of Life"]. */
  genres: readonly string[];
  /** Style for the wrapping row (the RSC passes its inline token object). */
  style?: CSSProperties;
  /** Style applied to every chip. */
  chipStyle?: CSSProperties;
}

/**
 * Renders the whole genre row in a single client instance. The chip *text*
 * is localised; the underlying enum value is untouched, so nothing here
 * changes the values used in /search?genre= links elsewhere.
 */
export function GenreChips({ genres, style, chipStyle }: GenreChipsProps) {
  const { lang } = useLang();
  if (!genres.length) return null;
  return (
    <div style={style}>
      {genres.map((g) => (
        <span key={g} style={chipStyle}>
          {genreLabel(g, lang)}
        </span>
      ))}
    </div>
  );
}

interface FormatBadgeProps {
  /** Raw AniList format enum, e.g. "TV_SHORT". */
  format: string;
  style?: CSSProperties;
}

/** Hero format badge — "TV_SHORT" → "TV 短篇" (zh) / "Short" (en). */
export function FormatBadge({ format, style }: FormatBadgeProps) {
  const { lang } = useLang();
  if (!format) return null;
  return <span style={style}>{formatLabel(format, lang)}</span>;
}
