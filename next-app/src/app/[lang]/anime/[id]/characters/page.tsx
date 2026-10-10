// /anime/[id]/characters — the 角色 tab: every character the catalogue holds
// for the title, with their voices in one dub at a time.
//
// The same route class as the overview and kept the same way: ISR with a 60s
// window, the trending set prerendered, every other id rendered and cached on
// its first request, and nothing read from cookies() or headers() — the page
// is served from the ISR cache and a Cloudflare edge cache, so the filters,
// the search and 「再显示」 are a client leaf (CharacterBrowser) that asks the
// API from the browser.
//
// An id the catalogue does not hold is a real 404. The read that decides that
// (credit-counts) never goes to AniList, and it comes before the detail
// document, which can: a crawler asking for /anime/<anything>/characters
// costs a primary-key read, not an upstream call. There is no loading.tsx
// anywhere above this route, so notFound() still sets the status
// (app/routeBoundaries.test.ts).
//
// The counts and the cast the page shows are read after the detail, keyed to
// its cachedAt: for a title only a listing has written, the detail fetch is
// what fills the credit tables (see _detail/detailData.ts `snapshot`).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CAST_FIRST_PAGE, charactersQuery } from "@/lib/detail/cast";
import { pickSeoTitle } from "@/lib/formatters";
import { fill } from "@/lib/i18n";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import DetailShell from "../_detail/DetailShell";
import {
  detailStaticParams,
  loadCharacters,
  loadCommunityCount,
  loadCreditCounts,
  loadKnownDetail,
  parseAnimeId,
} from "../_detail/detailData";
import CharacterBrowser from "./_components/CharacterBrowser";

// Literal, as Next requires of segment config — the same window as the
// overview and as the fetches in _detail/detailData.ts.
export const revalidate = 60;

// See the overview page: without generateStaticParams the route is dynamic
// and `revalidate` is ignored; dynamicParams keeps unlisted ids on demand.
export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  return detailStaticParams();
}

type CharactersPageProps = PageProps<"/[lang]/anime/[id]/characters">;

/** The page the server renders: all roles, the default dub (日配, the only one), no search. */
const FIRST_PAGE = charactersQuery({ role: "all", dub: null, q: "", offset: 0, limit: CAST_FIRST_PAGE });

/** Everything the page needs, or null for a title the catalogue does not hold. */
async function loadPage(id: number) {
  const detail = await loadKnownDetail(id);
  if (!detail) return null;
  const [counts, cast, communityCount] = await Promise.all([
    loadCreditCounts(id, detail.cachedAt),
    loadCharacters(id, FIRST_PAGE, detail.cachedAt),
    loadCommunityCount(id),
  ]);
  if (!counts || !cast) return null;
  return { counts, cast, communityCount, detail };
}

export async function generateMetadata({ params }: CharactersPageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = parseAnimeId(id);
  if (anilistId === null) return { title: { absolute: "AnimeGoClub" } };

  const [{ locale, lang, dict }, page] = await Promise.all([resolveLocale(params), loadPage(anilistId)]);
  if (!page) return { title: { absolute: "AnimeGoClub" } };

  // pickSeoTitle, as the overview's metadata: these strings are read by
  // machines, and on zh-Hant only the SERP-safe Traditional title may reach
  // them.
  const title = pickSeoTitle(page.detail, lang);
  const pageTitle = fill(dict.detail.charactersPageTitle, { title });
  const description = fill(dict.detail.charactersPageDescription, {
    title,
    n: page.counts.characters,
  });
  const canonical = `/anime/${anilistId}/characters`;
  const image = page.detail.bannerImageUrl || page.detail.coverImageUrl || null;
  return {
    title: { absolute: `${pageTitle} · AnimeGoClub` },
    description,
    openGraph: {
      title: pageTitle,
      description,
      siteName: "AnimeGoClub",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
      type: "website",
      url: canonical,
      ...(image ? { images: [image] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: pageTitle,
      description,
      ...(image ? { images: [image] } : {}),
    },
    alternates: buildAlternates(canonical, locale),
  };
}

export default async function AnimeCharactersPage({ params }: CharactersPageProps) {
  const { id } = await params;
  const anilistId = parseAnimeId(id);
  if (anilistId === null) notFound();

  const [{ dict, lang }, page] = await Promise.all([resolveLocale(params), loadPage(anilistId)]);
  if (!page) notFound();

  return (
    <DetailShell
      detail={page.detail}
      lang={lang}
      dict={dict}
      active="characters"
      counts={{ characters: page.counts.characters, staff: page.counts.staff, social: page.communityCount }}
    >
      {/* Keyed by title: a client-side move to another title's 角色 tab
          reuses this component, and its state belongs to the old one. */}
      <CharacterBrowser key={anilistId} anilistId={anilistId} initial={page.cast} />
    </DetailShell>
  );
}
