// /anime/[id]/social — the 社区 tab: reviews, discussion threads, recent
// activity and who is following the anime.
//
// ── Caching: the same contract as /anime/[id] ───────────────────────────
//
// ISR + the Cloudflare edge cache, so this server render is ANONYMOUS and the
// same for every reader. Nothing here reads cookies(), headers() or
// searchParams, and every fetch is `auth: false`: reading request state would
// force the route dynamic (killing ISR), and caching anything per-reader would
// hand one reader's page to everyone. What differs per reader — their private
// review, their votes, whether something is theirs, the composer — is fetched
// in the browser after load (components/community/SocialTab.tsx).
//
// What the server does render is the public community: non-private reviews
// (spoiler reviews folded, their bodies not shipped), threads, activity and
// the 谁在追 list — real text in the HTML, for search engines and for the
// first paint.
//
// ── 404 ─────────────────────────────────────────────────────────────────
//
// An unknown id answers HTTP 404, not a 200 not-found page. That holds only
// because no loading.tsx sits above this route (app/routeBoundaries.test.ts
// guards it): notFound() below runs before anything has streamed. As on the
// 角色 and 制作 tabs, the read that decides it never goes to AniList
// (loadKnownDetail).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SocialTab from "@/components/community/SocialTab";
import { loadCommunity } from "@/lib/community/server";
import { fillTemplate } from "@/lib/community/format";
import { pickSeoTitle, pickTitle } from "@/lib/formatters";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";
import DetailShell from "../_detail/DetailShell";
import { loadCreditCountsSoft, loadKnownDetail, parseAnimeId } from "../_detail/detailData";

// Literal on purpose: Next reads segment config statically, and an imported
// constant fails `next build` while passing dev and tsc (see the note in
// the hub pages). 60 = the detail page's window.
export const revalidate = 60;

// Without generateStaticParams a `[param]` route is always dynamic and
// `revalidate` is ignored. Nothing is prerendered at build time — every id is
// rendered and cached on its first request (dynamicParams).
export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  return [];
}

type SocialPageProps = PageProps<"/[lang]/anime/[id]/social">;

export async function generateMetadata({ params }: SocialPageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = parseAnimeId(id);
  if (anilistId === null) return { title: { absolute: "AnimeGoClub" } };
  const [{ locale, lang, dict }, detail] = await Promise.all([resolveLocale(params), loadKnownDetail(anilistId)]);
  if (!detail) return { title: { absolute: "AnimeGoClub" } };

  const title = fillTemplate(dict.community.metaTitle, { title: pickSeoTitle(detail, lang) });
  const description = fillTemplate(dict.community.metaDescription, { title: pickSeoTitle(detail, lang) });
  const canonical = `/anime/${anilistId}/social`;
  return {
    title: { absolute: `${title} · AnimeGoClub` },
    description,
    openGraph: { title, description, siteName: "AnimeGoClub", type: "website", url: canonical },
    alternates: buildAlternates(canonical, locale),
  };
}

export default async function SocialPage({ params }: SocialPageProps) {
  const { id } = await params;
  const anilistId = parseAnimeId(id);
  if (anilistId === null) notFound();

  const [{ dict, lang }, detail] = await Promise.all([resolveLocale(params), loadKnownDetail(anilistId)]);
  if (!detail) notFound();
  // The counts after the detail, keyed to it, as on the other tabs (see
  // _detail/detailData.ts `snapshot`); the tab's own number is the anonymous
  // render's totals, which is what /community/count adds up on the others.
  const [counts, community] = await Promise.all([
    loadCreditCountsSoft(anilistId, detail.cachedAt),
    loadCommunity(anilistId),
  ]);
  const count = community
    ? community.reviews.total + community.threads.total + community.activity.total
    : null;

  return (
    <DetailShell
      detail={detail}
      lang={lang}
      dict={dict}
      active="social"
      counts={{ characters: counts?.characters, staff: counts?.staff, social: count }}
    >
      <SocialTab
        anilistId={anilistId}
        animeTitle={pickTitle(detail, lang)}
        coverUrl={detail.coverImageUrl}
        initial={community}
        renderedAt={new Date().toISOString()}
        lang={lang}
      />
    </DetailShell>
  );
}
