// /studio/[name] — every non-adult title a studio animated (main studio
// only; the committee and the licensor are not who a visitor means by
// "MAPPA's anime"). Keyed by name because that is the key the table has;
// studio ids arrive with re-fetches and will let this move to /studio/[id]
// when coverage is there.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HubListing } from "@/components/hubs/HubListing";
import { fetchHub, parseHubPage } from "@/lib/hubs/fetch";
import { studioHeading } from "@/lib/hubs/headings";
import { studioPath } from "@/lib/hubs/paths";
import { OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";

// A literal, not the imported HUB_REVALIDATE: Next reads segment config
// statically and refuses an identifier here ("Unknown identifier ... at
// revalidate" at build time -- next dev does not check). Keep in step with
// lib/hubs/fetch.ts.
export const revalidate = 300;

type Props = PageProps<"/[lang]/studio/[name]">;

const MAX_NAME_LENGTH = 120;

function parseStudioName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const name = parseStudioName((await params).name);
  if (!name) return { title: "Studio" };
  const { locale, lang, dict } = await resolveLocale(params);
  const page = parseHubPage((await searchParams).page);
  const heading = studioHeading(name, lang);
  const title = page > 1 ? `${heading} · ${page}` : heading;
  const description = `${heading} — ${dict.hub.metaSuffix}`;
  const canonical = page > 1 ? `${studioPath(name)}?page=${page}` : studioPath(name);
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

export default async function StudioPage({ params, searchParams }: Props) {
  const name = parseStudioName((await params).name);
  if (!name) notFound();
  const page = parseHubPage((await searchParams).page);
  const [{ dict, lang }, { items, pagination }] = await Promise.all([
    resolveLocale(params),
    fetchHub("studio", name, page),
  ]);
  // A studio nobody has titles for is not a page.  The API answers 200
  // with an empty list (it cannot tell "unknown studio" from "no titles"),
  // so the decision is made here, where a 404 is what a crawler should see.
  if (pagination.total === 0) notFound();
  return (
    <HubListing
      heading={studioHeading(name, lang)}
      basePath={studioPath(name)}
      items={items}
      pagination={pagination}
      lang={lang}
      dict={dict}
    />
  );
}
