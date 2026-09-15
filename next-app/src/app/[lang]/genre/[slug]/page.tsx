// /genre/[slug] — every non-adult title carrying one AniList genre, by
// popularity. The first of the hub pages: until it existed the genre chips
// on 18k detail pages were <span>s, and the catalogue had no page that
// linked to more than one title at a time.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HubListing } from "@/components/hubs/HubListing";
import { genreLabel } from "@/lib/contentLabels";
import { fetchHub, parseHubPage } from "@/lib/hubs/fetch";
import { genreFromSlug, genrePath } from "@/lib/hubs/paths";
import { OG_LOCALE, alternateOgLocales, type Lang } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";

// A literal, not the imported HUB_REVALIDATE: Next reads segment config
// statically and refuses an identifier here ("Unknown identifier ... at
// revalidate" at build time -- next dev does not check). Keep in step with
// lib/hubs/fetch.ts.
export const revalidate = 300;

type Props = PageProps<"/[lang]/genre/[slug]">;

const HEADING: Record<Lang, (label: string) => string> = {
  zh: (label) => `${label}番剧`,
  en: (label) => `${label} Anime`,
  "zh-Hant": (label) => `${label}番劇`,
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const genre = genreFromSlug(slug);
  if (!genre) return { title: "Genre" };
  const { locale, lang, dict } = await resolveLocale(params);
  const page = parseHubPage((await searchParams).page);
  const label = genreLabel(genre, lang);
  const title = page > 1 ? `${HEADING[lang](label)} · ${page}` : HEADING[lang](label);
  const description = `${HEADING[lang](label)} — ${dict.hub.metaSuffix}`;
  // Page 1 is the bare path; deeper pages carry ?page= in their canonical
  // so each is its own indexable URL rather than a duplicate of page 1.
  const canonical = page > 1 ? `${genrePath(genre)}?page=${page}` : genrePath(genre);
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
  const page = parseHubPage((await searchParams).page);
  const [{ dict, lang }, { items, pagination }] = await Promise.all([
    resolveLocale(params),
    fetchHub("genre", genre, page),
  ]);
  return (
    <HubListing
      heading={HEADING[lang](genreLabel(genre, lang))}
      basePath={genrePath(genre)}
      items={items}
      pagination={pagination}
      lang={lang}
      dict={dict}
    />
  );
}
