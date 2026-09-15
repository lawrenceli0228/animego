// The hub sitemap's rows: every genre, studio, year and season page the
// catalogue has, from /api/anime/hubs. Pure, like animeSitemapRows, so the
// document can be tested without a server.

import type { MetadataRoute } from "next";
import { SITE_ORIGIN as SITE } from "@/lib/seo/alternates";
import { expandLocales } from "@/lib/seo/sitemapEntry";
import { genreFromSlug, genrePath, genreSlug, studioPath, yearPath } from "@/lib/hubs/paths";

export interface HubsPayload {
  genres: Array<{ key: string; count: number }>;
  studios: Array<{ key: string; count: number }>;
  years: Array<{ key: string; count: number }>;
  seasons: Array<{ season: string; year: number; count: number }>;
}

export const HUBS_SITEMAP_PATH = "/sitemaps/hubs/sitemap.xml";

export function hubsSitemapUrl(): string {
  return `${SITE}${HUBS_SITEMAP_PATH}`;
}

/**
 * Genre hubs exist only for genres the site has a page for (the filter
 * list; never the adult genre). Studio and year hubs exist for whatever
 * the API lists — it already applies the studio floor and excludes adult
 * titles. Seasons are the 291 pages /seasonal has always rendered and,
 * until now, listed one of.
 */
export function hubSitemapRows(hubs: HubsPayload, now: Date): MetadataRoute.Sitemap {
  const genres = hubs.genres
    .filter((g) => genreFromSlug(genreSlug(g.key)) !== null)
    .map((g) => ({ path: genrePath(g.key), priority: 0.7 }));
  const studios = hubs.studios.map((s) => ({ path: studioPath(s.key), priority: 0.5 }));
  const years = hubs.years.map((y) => ({ path: yearPath(Number(y.key)), priority: 0.6 }));
  const seasons = hubs.seasons.map((s) => ({
    path: `/seasonal/${s.season.toLowerCase()}/${s.year}`,
    priority: 0.5,
  }));
  return [...genres, ...years, ...seasons, ...studios].flatMap((e) =>
    expandLocales({ path: e.path, lastModified: now, changeFrequency: "weekly", priority: e.priority }),
  );
}
