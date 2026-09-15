// /year/[year] — every non-adult title released in a year, by the year of
// its season or, for the quarter of the catalogue with no season (films,
// OVAs, specials), the year of its start date.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HubListing } from "@/components/hubs/HubListing";
import { fetchHub, HUB_REVALIDATE, parseHubPage } from "@/lib/hubs/fetch";
import { parseHubYear, yearPath } from "@/lib/hubs/paths";
import { OG_LOCALE, alternateOgLocales, type Lang } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";

export const revalidate = HUB_REVALIDATE;

type Props = PageProps<"/[lang]/year/[year]">;

const HEADING: Record<Lang, (year: number) => string> = {
  zh: (year) => `${year}年番剧`,
  en: (year) => `Anime of ${year}`,
  "zh-Hant": (year) => `${year}年番劇`,
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const year = parseHubYear((await params).year);
  if (year === null) return { title: "Year" };
  const { locale, lang, dict } = await resolveLocale(params);
  const page = parseHubPage((await searchParams).page);
  const title = page > 1 ? `${HEADING[lang](year)} · ${page}` : HEADING[lang](year);
  const description = `${HEADING[lang](year)} — ${dict.hub.metaSuffix}`;
  const canonical = page > 1 ? `${yearPath(year)}?page=${page}` : yearPath(year);
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

export default async function YearPage({ params, searchParams }: Props) {
  const year = parseHubYear((await params).year);
  if (year === null) notFound();
  const page = parseHubPage((await searchParams).page);
  const [{ dict, lang }, { items, pagination }] = await Promise.all([
    resolveLocale(params),
    fetchHub("year", String(year), page),
  ]);
  if (pagination.total === 0) notFound();
  return (
    <HubListing
      heading={HEADING[lang](year)}
      basePath={yearPath(year)}
      items={items}
      pagination={pagination}
      lang={lang}
      dict={dict}
    />
  );
}
