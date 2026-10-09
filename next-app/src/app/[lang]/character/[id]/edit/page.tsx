// /character/[id]/edit — the character page in its edit state.
//
// A route of its own rather than a mode of /character/[id]: the page stays an
// ISR render that never reads a cookie (one HTML for every reader, its 「编辑」
// a plain link), while this route is dynamic (it reads the session cookie),
// noindex, and knows who is asking. Reload, back and a shared link all land
// in the same state.
//
// Whether the page exists comes first, from the same cached read the public
// page makes -- taken before the cookie is read, which is what keeps it
// cached -- so an unknown id is a real 404 here as there, and a signed-out
// visitor, sent to log in and back, costs the API no more than the page
// does. Only a signed-in reader gets the page read fresh: the draft is
// diffed against it, and an edit accepted a moment ago must be in it.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import Breadcrumbs from "@/components/people/Breadcrumbs";
import { characterCrumbs } from "@/components/people/CharacterView";
import CharacterEditor from "@/components/people/edit/CharacterEditor";
import { readSession } from "@/lib/auth/serverSession";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { loadCharacter, loadCharacterFresh } from "@/lib/people/fetch";
import { characterEditPath, characterPath, parseEntityId } from "@/lib/people/paths";
import { primaryAppearance } from "@/lib/people/primary";
import { characterHeading } from "@/lib/people/seo";
import { hueStyle } from "@/lib/people/view";

type CharacterEditProps = PageProps<"/[lang]/character/[id]/edit">;

export async function generateMetadata({ params }: CharacterEditProps): Promise<Metadata> {
  const robots = { index: false, follow: false };
  const id = parseEntityId((await params).id);
  if (id === null) return { title: { absolute: "AnimeGoClub" }, robots };
  const [{ lang, dict }, character] = await Promise.all([resolveLocale(params), loadCharacter(id)]);
  if (!character) return { title: { absolute: "AnimeGoClub" }, robots };
  const name = characterHeading(character, lang);
  return { title: { absolute: `${dict.peopleEdit.pageTitle.replace("{{name}}", name)} · AnimeGoClub` }, robots };
}

export default async function CharacterEditPage({ params }: CharacterEditProps) {
  const id = parseEntityId((await params).id);
  if (id === null) notFound();
  const [{ locale, lang, dict }, exists] = await Promise.all([resolveLocale(params), loadCharacter(id)]);
  if (!exists) notFound();
  if (!(await readSession())) redirect(authHrefWithFrom("/login", localizePath(characterEditPath(id), locale)));
  const character = await loadCharacterFresh(id);
  if (!character) notFound();

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
