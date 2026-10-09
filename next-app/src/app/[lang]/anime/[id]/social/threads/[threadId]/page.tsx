// /anime/[id]/social/threads/[threadId] — one discussion thread and its
// replies.
//
// Same caching contract as the tab (see ../../page.tsx): ISR, edge-cached,
// an anonymous render with every per-reader part fetched in the browser
// (components/community/ThreadView.tsx). A missing, removed or malformed
// thread is a real 404 — no loading.tsx above this route.
//
// A spoiler thread's body is folded on the page and kept out of the meta
// description, so a search result never quotes it.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import HeroAccent from "@/components/anime/HeroAccent";
import ThreadView from "@/components/community/ThreadView";
import { isThreadId, loadAnime, loadThread } from "@/lib/community/server";
import { plainText, parseReview } from "@/lib/community/reviewMarkup";
import { pickSeoTitle, pickTitle, truncate } from "@/lib/formatters";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";

export const revalidate = 60;
export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string; threadId: string }>> {
  return [];
}

type ThreadPageProps = PageProps<"/[lang]/anime/[id]/social/threads/[threadId]">;

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function generateMetadata({ params }: ThreadPageProps): Promise<Metadata> {
  const { id, threadId } = await params;
  const anilistId = parseId(id);
  if (!anilistId || !isThreadId(threadId)) return { title: { absolute: "AnimeGoClub" } };
  const [{ locale, lang }, detail, view] = await Promise.all([
    resolveLocale(params),
    loadAnime(anilistId),
    loadThread(anilistId, threadId),
  ]);
  if (!detail || !view) return { title: { absolute: "AnimeGoClub" } };
  const title = `${view.thread.title} · ${pickSeoTitle(detail, lang)}`;
  const description = view.thread.isSpoiler ? undefined : truncate(plainText(parseReview(view.thread.body)), 160);
  const canonical = `/anime/${anilistId}/social/threads/${view.thread.id}`;
  return {
    title: { absolute: `${title} · AnimeGoClub` },
    description,
    openGraph: { title, description, siteName: "AnimeGoClub", type: "article", url: canonical },
    alternates: buildAlternates(canonical, locale),
  };
}

export default async function ThreadPage({ params }: ThreadPageProps) {
  const { id, threadId } = await params;
  const anilistId = parseId(id);
  if (!anilistId || !isThreadId(threadId)) notFound();
  const [{ lang }, detail, view] = await Promise.all([
    resolveLocale(params),
    loadAnime(anilistId),
    loadThread(anilistId, threadId),
  ]);
  if (!detail || !view) notFound();

  return (
    <HeroAccent
      anilistId={detail.anilistId}
      coverImageUrl={detail.coverImageUrl}
      posterAccent={detail.posterAccent ?? null}
      posterAccentRgb={detail.posterAccentRgb ?? null}
    >
      <main>
        <ThreadView
          anilistId={anilistId}
          animeTitle={pickTitle(detail, lang)}
          initial={view}
          renderedAt={new Date().toISOString()}
          lang={lang}
        />
      </main>
    </HeroAccent>
  );
}
