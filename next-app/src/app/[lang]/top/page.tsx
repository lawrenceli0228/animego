// /top — the hundred best-rated shows of every year (AniList's Top 100):
// rated, not adult, not a music video, and tracked by at least a thousand
// AniList users. Narrowed by ?format=, ?genre= (each the hundred best of what
// is left, numbered afresh), drawn as covers, chart cards or a list (?view=).
//
// Server-rendered: every ranked show is a real link in the HTML, in order,
// since search is how readers arrive; the client tree (components/top) only
// decides how many are visible. Its canonical is its own address with the
// filters in one order; a filtered ranking is noindex.
//
// No loading.tsx, as on the genre page: a streamed response cannot change its
// status after the first byte, and /top/[year] must be able to answer 404.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import TopBrowse from "@/components/top/TopBrowse";
import { queryFromRecord } from "@/lib/genre/views";
import { resolveLocale } from "@/lib/i18n/route";
import { jsonLdHtml } from "@/lib/top/jsonLd";
import { loadTopPage, topMetadata } from "@/lib/top/page";
import { parseTopState } from "@/lib/top/query";

// A literal, not an imported constant: Next reads segment config statically
// and refuses an identifier here ("Unknown identifier ... at revalidate" at
// build time -- next dev does not check). Keep in step with TOP_REVALIDATE in
// lib/top/fetch.ts.
export const revalidate = 300;

type Props = PageProps<"/[lang]/top">;

/** This request's render time: a helper rather than Date.now() in the body, which react-hooks/purity rejects. */
function requestTime(): number {
  return Date.now();
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, lang, dict } = await resolveLocale(params);
  return topMetadata(parseTopState(queryFromRecord(await searchParams), null), lang, locale, dict);
}

export default async function TopPage({ params, searchParams }: Props) {
  const { locale, lang } = await resolveLocale(params);
  const state = parseTopState(queryFromRecord(await searchParams), null);
  const nowMs = requestTime();
  // Only a year's page can be missing; this one never is.
  const page = await loadTopPage(state, lang, locale, nowMs);
  if (!page) notFound();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(page.jsonLd) }} />
      <TopBrowse data={page.data} serverNowMs={nowMs} />
    </>
  );
}
