// /character/[id] — one AniList Character id. ISR, static params, 404 and
// the anonymous-render rule exactly as /person/[id], for the reasons given
// there.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CharacterView from "@/components/people/CharacterView";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { loadCharacter } from "@/lib/people/fetch";
import { characterPath, parseEntityId } from "@/lib/people/paths";
import { primaryAppearance } from "@/lib/people/primary";
import {
  breadcrumbJsonLd,
  characterBreadcrumbSteps,
  characterMetaDescription,
  characterMetaTitle,
} from "@/lib/people/seo";
import { buildAlternates } from "@/lib/seo/alternates";

// Literal: Next reads segment config statically. Keep in step with
// PEOPLE_REVALIDATE_SECONDS in lib/people/fetch.ts.
export const revalidate = 60;

export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  return [];
}

type CharacterPageProps = PageProps<"/[lang]/character/[id]">;

export async function generateMetadata({ params }: CharacterPageProps): Promise<Metadata> {
  const id = parseEntityId((await params).id);
  if (id === null) return { title: { absolute: "AnimeGoClub" } };
  const [{ locale, lang, dict }, character] = await Promise.all([resolveLocale(params), loadCharacter(id)]);
  if (!character) return { title: { absolute: "AnimeGoClub" } };

  const primary = primaryAppearance(character);
  const title = characterMetaTitle(character, primary, lang, dict);
  const description = characterMetaDescription(character, primary, lang, dict);
  const canonical = characterPath(id);
  const images = [character.image ?? "/og-default.png"];
  return {
    title: { absolute: title },
    description,
    alternates: buildAlternates(canonical, locale),
    // A lead with a Chinese name is indexed; the rest are served and followed
    // (go-api internal/people, characterIndexable).
    ...(character.indexable ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title,
      description,
      siteName: "AnimeGoClub",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
      type: "website",
      url: canonical,
      images,
    },
    twitter: { card: "summary", title, description, images },
  };
}

export default async function CharacterPage({ params }: CharacterPageProps) {
  const id = parseEntityId((await params).id);
  if (id === null) notFound();
  const [{ locale, lang, dict }, character] = await Promise.all([resolveLocale(params), loadCharacter(id)]);
  if (!character) notFound();

  // A BreadcrumbList and no entity: schema.org has no type for a fictional
  // character (see lib/people/seo.ts).
  const breadcrumb = breadcrumbJsonLd(characterBreadcrumbSteps(character, lang, dict), locale);
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb).replace(/</g, "\\u003c") }}
      />
      <CharacterView character={character} lang={lang} dict={dict} />
    </>
  );
}
