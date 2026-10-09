// /person/[id] — one AniList Staff id: a voice actor, a member of staff, or
// both (AniList keeps them as one kind of record, and so does this page).
//
// ISR on /anime/[id]'s terms, and for its reasons:
//   - `revalidate = 60` and `dynamicParams = true`, with a generateStaticParams
//     so the route is ISR rather than `ƒ` (a `[param]` route without one is
//     dynamic, and `revalidate` is then ignored).
//   - Nothing at render reads cookies, headers or searchParams; the API read
//     is auth:false (lib/people/fetch.ts). The page is one cached document
//     per URL, and the locale is part of the URL.
//
// generateStaticParams returns nothing, where /anime/[id] prerenders the
// trending set. Prerendering exists there because a cold anime page can wait
// on AniList; this page reads the database and nothing else, so its first
// render costs one indexed query and there is nothing to warm. An empty list
// keeps every id ISR-on-demand.
//
// A real 404 for an id no non-adult title credits: there is no loading.tsx
// above this route (routeBoundaries.test.ts keeps it that way), so the
// response has not started streaming when notFound() runs.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PersonView from "@/components/people/PersonView";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { loadPerson } from "@/lib/people/fetch";
import { parseEntityId, personPath } from "@/lib/people/paths";
import {
  breadcrumbJsonLd,
  personBreadcrumbSteps,
  personJsonLd,
  personMetaDescription,
  personMetaTitle,
} from "@/lib/people/seo";
import { buildAlternates } from "@/lib/seo/alternates";

// Literal: Next reads segment config statically. Keep in step with
// PEOPLE_REVALIDATE_SECONDS in lib/people/fetch.ts.
export const revalidate = 60;

export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  return [];
}

type PersonPageProps = PageProps<"/[lang]/person/[id]">;

export async function generateMetadata({ params }: PersonPageProps): Promise<Metadata> {
  const id = parseEntityId((await params).id);
  if (id === null) return { title: { absolute: "AnimeGoClub" } };
  const [{ locale, lang, dict }, person] = await Promise.all([resolveLocale(params), loadPerson(id)]);
  if (!person) return { title: { absolute: "AnimeGoClub" } };

  const title = personMetaTitle(person, lang, dict);
  const description = personMetaDescription(person, lang, dict);
  const canonical = personPath(id);
  const images = [person.image ?? "/og-default.png"];
  return {
    title: { absolute: title },
    description,
    alternates: buildAlternates(canonical, locale),
    // Below the indexing threshold (go-api internal/people,
    // MinIndexedVoiceWorks): served, not indexed, links still followed.
    ...(person.indexable ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title,
      description,
      siteName: "AnimeGoClub",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
      type: "profile",
      url: canonical,
      images,
    },
    twitter: { card: "summary", title, description, images },
  };
}

export default async function PersonPage({ params }: PersonPageProps) {
  const id = parseEntityId((await params).id);
  if (id === null) notFound();
  const [{ locale, lang, dict }, person] = await Promise.all([resolveLocale(params), loadPerson(id)]);
  if (!person) notFound();

  // Built from typed API fields; `<` is escaped anyway so no value can close
  // the script element.
  const jsonLd = [personJsonLd(person, lang, locale), breadcrumbJsonLd(personBreadcrumbSteps(person, lang, dict), locale)];
  return (
    <>
      {jsonLd.map((doc) => (
        <script
          key={doc["@type"]}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(doc).replace(/</g, "\\u003c") }}
        />
      ))}
      <PersonView person={person} lang={lang} dict={dict} />
    </>
  );
}
