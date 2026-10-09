// /character/[id]/edit — the character page in its edit state.
//
// A route of its own rather than a mode of /character/[id]: the page stays an
// ISR render that never reads a cookie (one HTML for every reader, its 「编辑」
// a plain link), while this route is dynamic, noindex, and knows who is
// asking. An unknown id is a real 404 here as there, before anything about
// the reader is read; a signed-out reader is sent to log in and back. Reload,
// back and a shared link all land in the same state.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import Breadcrumbs from "@/components/people/Breadcrumbs";
import { characterCrumbs } from "@/components/people/CharacterView";
import CharacterEditor from "@/components/people/edit/CharacterEditor";
import { readSession } from "@/lib/auth/serverSession";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { loadCharacterFresh } from "@/lib/people/fetch";
import { characterEditPath, characterPath, parseEntityId } from "@/lib/people/paths";
import { primaryAppearance } from "@/lib/people/primary";
import { characterHeading } from "@/lib/people/seo";
import { hueStyle } from "@/lib/people/view";

export const dynamic = "force-dynamic";

type CharacterEditProps = PageProps<"/[lang]/character/[id]/edit">;

export async function generateMetadata({ params }: CharacterEditProps): Promise<Metadata> {
  const robots = { index: false, follow: false };
  const id = parseEntityId((await params).id);
  if (id === null) return { title: { absolute: "AnimeGoClub" }, robots };
  const [{ lang, dict }, character] = await Promise.all([resolveLocale(params), loadCharacterFresh(id)]);
  if (!character) return { title: { absolute: "AnimeGoClub" }, robots };
  const name = characterHeading(character, lang);
  return { title: { absolute: `${dict.peopleEdit.pageTitle.replace("{{name}}", name)} · AnimeGoClub` }, robots };
}

export default async function CharacterEditPage({ params }: CharacterEditProps) {
  const id = parseEntityId((await params).id);
  if (id === null) notFound();
  const [{ locale, lang, dict }, character] = await Promise.all([resolveLocale(params), loadCharacterFresh(id)]);
  if (!character) notFound();
  if (!(await readSession())) redirect(authHrefWithFrom("/login", localizePath(characterEditPath(id), locale)));

  const crumbs = characterCrumbs(character, lang, dict).map((c, i, all) =>
    i === all.length - 1 ? { ...c, href: characterPath(id) } : c,
  );
  crumbs.push({ label: dict.peopleEdit.crumb });
  return (
    <CharacterEditor
      character={character}
      lang={lang}
      crumbs={<Breadcrumbs items={crumbs} label={dict.people.breadcrumb} />}
      pageHref={localizePath(characterPath(id), locale)}
      hue={hueStyle(primaryAppearance(character)?.anime.posterAccent)}
    />
  );
}
