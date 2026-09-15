// The URL shapes of the three hub pages, in one place so the links on the
// detail page, the pages themselves, and the sitemap cannot disagree.
//
//   /genre/slice-of-life   — slug of the AniList genre enum
//   /studio/MAPPA          — the studio's name, URL-encoded (no id yet on
//                            most rows; the name is the key the table has)
//   /year/2024             — release year
//
// Bare paths, like every other href in the tree: the [lang] segment is
// applied by the proxy for the non-default locale.

import { FILTER_GENRES, type FilterGenre } from "@/lib/contentLabels";

/** "Slice of Life" → "slice-of-life"; "Sci-Fi" → "sci-fi". */
export function genreSlug(genre: string): string {
  return genre.toLowerCase().replace(/\s+/g, "-");
}

const GENRE_BY_SLUG: ReadonlyMap<string, FilterGenre> = new Map(
  FILTER_GENRES.map((g) => [genreSlug(g), g]),
);

/** The genre enum for a slug, or null for anything that is not a hub. */
export function genreFromSlug(slug: string): FilterGenre | null {
  return GENRE_BY_SLUG.get(slug) ?? null;
}

export function genrePath(genre: string): string {
  return `/genre/${genreSlug(genre)}`;
}

export function studioPath(name: string): string {
  return `/studio/${encodeURIComponent(name)}`;
}

export function yearPath(year: number): string {
  return `/year/${year}`;
}

/** A hub page is a year between the oldest title and a little past today. */
export function parseHubYear(raw: string): number | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const y = Number(raw);
  if (y < 1900 || y > new Date().getFullYear() + 3) return null;
  return y;
}
