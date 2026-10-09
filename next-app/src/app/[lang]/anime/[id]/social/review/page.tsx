// /anime/[id]/social/review — write a review, or edit the one you wrote
// (the canvas's WriteReview board).
//
// The page is the same cached shell for everybody: the anime's title and
// cover, and the form. Whether the reader is signed in, and whether they
// already have a review to edit, is found out in the browser
// (WriteReviewForm), so this render reads no cookie and stays ISR like the
// rest of /anime/*. Not indexed: it is a form, not content.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import HeroAccent from "@/components/anime/HeroAccent";
import WriteReviewForm from "@/components/community/WriteReviewForm";
import { loadAnime } from "@/lib/community/server";
import { pickTitle } from "@/lib/formatters";
import { resolveLocale } from "@/lib/i18n/route";

export const revalidate = 60;
export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  return [];
}

type WriteReviewPageProps = PageProps<"/[lang]/anime/[id]/social/review">;

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function generateMetadata({ params }: WriteReviewPageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = parseId(id);
  const [{ lang, dict }, detail] = await Promise.all([
    resolveLocale(params),
    anilistId ? loadAnime(anilistId) : Promise.resolve(null),
  ]);
  const title = detail ? `${dict.community.writeTitle} · ${pickTitle(detail, lang)}` : dict.community.writeTitle;
  return {
    title: { absolute: `${title} · AnimeGoClub` },
    robots: { index: false, follow: true },
  };
}

export default async function WriteReviewPage({ params }: WriteReviewPageProps) {
  const { id } = await params;
  const anilistId = parseId(id);
  if (!anilistId) notFound();
  const [{ lang }, detail] = await Promise.all([resolveLocale(params), loadAnime(anilistId)]);
  if (!detail) notFound();

  return (
    <HeroAccent
      anilistId={detail.anilistId}
      coverImageUrl={detail.coverImageUrl}
      posterAccent={detail.posterAccent ?? null}
      posterAccentRgb={detail.posterAccentRgb ?? null}
    >
      <main>
        <WriteReviewForm
          anilistId={anilistId}
          animeTitle={pickTitle(detail, lang)}
          coverUrl={detail.coverImageUrl}
        />
      </main>
    </HeroAccent>
  );
}
