// /genre/[slug] — one AniList genre, two views on one route.
//
//   the hub (no view in the query): the genre's count, a strip of every
//   genre, rails of what is airing, the most popular, recent and classic
//   shows, the top ten by score, and tiles for its decades, the genres it
//   goes with and its studios;
//
//   a grid (?list= / ?decade= / ?with=, and the old ?page=N): every title in
//   one slice, 36 to a page.
//
// Both are server-rendered — every title, genre, tile and next page is a real
// link in the HTML, since search is how readers arrive — and hydrate into the
// one client tree (components/genre). Each view's canonical is its own
// address (viewPath); the old ?page=N is a permanent redirect to the grid page
// holding its first title.
//
// No loading.tsx: a streamed response cannot change its status after the
// first byte. An unknown genre, and a grid page past the end of its slice,
// must answer 404, not a 200 soft 404; the old address must answer 308, not a
// meta refresh.

import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import GenreBrowse from "@/components/genre/GenreBrowse";
import { browseFilter, recentFromYear } from "@/lib/genre/api";
import { fetchBrowsePage, fetchOverview, fetchStrip } from "@/lib/genre/fetch";
import { buildGridData, type GenrePageData } from "@/lib/genre/grid";
import { buildHubData } from "@/lib/genre/hub";
import { gridMetaTitle } from "@/lib/genre/titles";
import { parseGenreView, queryFromRecord, viewPath, type GenreView, type GridView } from "@/lib/genre/views";
import { genreHeading } from "@/lib/hubs/headings";
import { genreFromSlug } from "@/lib/hubs/paths";
import type { FilterGenre } from "@/lib/contentLabels";
import { OG_LOCALE, alternateOgLocales, type Lang } from "@/lib/i18n/lang";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";

// A literal, not an imported constant: Next reads segment config statically
// and refuses an identifier here ("Unknown identifier ... at revalidate" at
// build time -- next dev does not check). Keep in step with GENRE_REVALIDATE
// in lib/genre/fetch.ts.
export const revalidate = 300;

type Props = PageProps<"/[lang]/genre/[slug]">;

/**
 * This request's render time — a helper rather than Date.now() in the
 * component body, which react-hooks/purity rejects (as on the seasonal page).
 * The cards' countdowns start from it, and "recent" is counted from its year.
 */
function requestTime(): number {
  return Date.now();
}

/**
 * Where "recent" starts for the grid: the year the overview counted the
 * rail from, so the grid opens on the rail's titles even across New Year
 * while the overview is cached; the same rule's own answer if there is no
 * overview to ask.
 */
async function recentFromOf(genre: FilterGenre, view: GridView, nowMs: number): Promise<number> {
  if (view.kind !== "list" || view.list !== "recent") return recentFromYear(nowMs);
  return (await fetchOverview(genre))?.recentFrom ?? recentFromYear(nowMs);
}

/** What the view shows: the hub from the overview, or the grid's page from browse. */
async function loadView(genre: FilterGenre, view: GenreView, nowMs: number, lang: Lang): Promise<GenrePageData> {
  if (view.kind === "hub") return buildHubData(await fetchOverview(genre), lang);
  const filter = browseFilter(genre, view.view, await recentFromOf(genre, view.view, nowMs));
  return buildGridData(view.view, view.page, filter, await fetchBrowsePage(filter, view.page), lang);
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const genre = genreFromSlug(slug);
  if (!genre) return { title: "Genre" };
  const { locale, lang, dict } = await resolveLocale(params);
  const view = parseGenreView(queryFromRecord(await searchParams), genre);
  const title =
    view.kind === "hub" ? genreHeading(genre, lang) : gridMetaTitle(genre, view.view, view.page, lang);
  const description = `${title} — ${dict.genrePage.metaSuffix}`;
  const canonical = viewPath(genre, view);
  return {
    title: { absolute: title },
    description,
    alternates: buildAlternates(canonical, locale),
    openGraph: {
      title,
      description,
      siteName: "AnimeGoClub",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
      type: "website",
      url: canonical,
    },
    twitter: { card: "summary", title, description },
  };
}

export default async function GenrePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const genre = genreFromSlug(slug);
  if (!genre) notFound();
  const view = parseGenreView(queryFromRecord(await searchParams), genre);
  const { locale, lang } = await resolveLocale(params);
  if (view.kind === "grid" && view.legacy) permanentRedirect(localizePath(viewPath(genre, view), locale));
  const nowMs = requestTime();
  const [strip, data] = await Promise.all([fetchStrip(), loadView(genre, view, nowMs, lang)]);
  // A page past the end of a slice that has titles does not exist. A slice
  // with none is the API not answering (or a pairing nobody made): the empty
  // grid, as ever.
  if (data.kind === "grid" && data.items.length === 0 && data.total > 0) notFound();

  return <GenreBrowse genre={genre} data={data} strip={strip} serverNowMs={nowMs} />;
}
