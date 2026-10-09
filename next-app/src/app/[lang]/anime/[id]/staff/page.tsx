// /anime/[id]/staff — the 制作 tab: every staff credit the catalogue holds
// for the title, grouped by department.
//
// Kept exactly like the overview and the 角色 tab: ISR with a 60s window, the
// trending set prerendered, every other id on demand, nothing read from
// cookies() or headers(). The whole list (at most 400 credits) is rendered
// into the cached HTML; the department chips and the search filter it in
// the browser (StaffBrowser).
//
// An id the catalogue does not hold is a real 404, decided by a read that
// never goes to AniList (credit-counts) before the detail document is asked
// for; the counts and the staff the page shows are read after the detail,
// keyed to it — see the 角色 page.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pickSeoTitle } from "@/lib/formatters";
import { fill } from "@/lib/i18n";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import DetailShell from "../_detail/DetailShell";
import {
  detailStaticParams,
  loadCommunityCount,
  loadCreditCounts,
  loadKnownDetail,
  loadStaff,
  parseAnimeId,
} from "../_detail/detailData";
import StaffBrowser from "./_components/StaffBrowser";

// Literal, as Next requires of segment config — the same window as the
// overview and as the fetches in _detail/detailData.ts.
export const revalidate = 60;

// See the overview page: without generateStaticParams the route is dynamic
// and `revalidate` is ignored; dynamicParams keeps unlisted ids on demand.
export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  return detailStaticParams();
}

type StaffPageProps = PageProps<"/[lang]/anime/[id]/staff">;

/** Everything the page needs, or null for a title the catalogue does not hold. */
async function loadPage(id: number) {
  const detail = await loadKnownDetail(id);
  if (!detail) return null;
  const [counts, staff, communityCount] = await Promise.all([
    loadCreditCounts(id, detail.cachedAt),
    loadStaff(id, detail.cachedAt),
    loadCommunityCount(id),
  ]);
  if (!counts || !staff) return null;
  return { counts, staff, communityCount, detail };
}

export async function generateMetadata({ params }: StaffPageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = parseAnimeId(id);
  if (anilistId === null) return { title: { absolute: "AnimeGoClub" } };

  const [{ locale, lang, dict }, page] = await Promise.all([resolveLocale(params), loadPage(anilistId)]);
  if (!page) return { title: { absolute: "AnimeGoClub" } };

  // pickSeoTitle, as the overview's metadata: on zh-Hant only the SERP-safe
  // Traditional title may reach a machine-read string.
  const title = pickSeoTitle(page.detail, lang);
  const pageTitle = fill(dict.detail.staffPageTitle, { title });
  const description = fill(dict.detail.staffPageDescription, { title, n: page.counts.staff });
  const canonical = `/anime/${anilistId}/staff`;
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

export default async function AnimeStaffPage({ params }: StaffPageProps) {
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
      active="staff"
      counts={{ characters: page.counts.characters, staff: page.counts.staff, social: page.communityCount }}
    >
      {/* Keyed by title: a client-side move to another title's staff tab
          reuses this component, and its filters belong to the old one. */}
      <StaffBrowser key={anilistId} credits={page.staff.data} />
    </DetailShell>
  );
}
