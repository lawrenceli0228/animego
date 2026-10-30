// /top/[year] — one release year's hundred best-rated shows, by the year the
// rest of the catalogue files a show under (its season's year, else its
// premiere's). Narrowed by ?format=, ?genre= and ?season=. See ../page.tsx for
// what the page is and how it renders.
//
// A year with nothing ranked has no page: 404, never an empty list (only a
// filter can empty a ranking that exists).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import TopBrowse from "@/components/top/TopBrowse";
import { queryFromRecord } from "@/lib/genre/views";
import { resolveLocale } from "@/lib/i18n/route";
import { jsonLdHtml } from "@/lib/top/jsonLd";
import { loadTopPage, topMetadata } from "@/lib/top/page";
import { parseTopState } from "@/lib/top/query";
import { parseTopYear } from "@/lib/top/years";

// A literal: see ../page.tsx.
export const revalidate = 300;

type Props = PageProps<"/[lang]/top/[year]">;

function requestTime(): number {
  return Date.now();
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const year = parseTopYear((await params).year);
  if (year === null) return { title: "Top 100" };
  const { locale, lang, dict } = await resolveLocale(params);
  return topMetadata(parseTopState(queryFromRecord(await searchParams), year), lang, locale, dict);
}

export default async function TopYearPage({ params, searchParams }: Props) {
  const year = parseTopYear((await params).year);
  if (year === null) notFound();
  const { locale, lang } = await resolveLocale(params);
  const state = parseTopState(queryFromRecord(await searchParams), year);
  const nowMs = requestTime();
  const page = await loadTopPage(state, lang, locale, nowMs);
  if (!page) notFound();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(page.jsonLd) }} />
      <TopBrowse data={page.data} serverNowMs={nowMs} />
    </>
  );
}
