// /person/[id]/edit — the person page in its edit state. A route of its own,
// dynamic and noindex, its reads ordered as /character/[id]/edit's are, for
// the reasons given there.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import Breadcrumbs from "@/components/people/Breadcrumbs";
import { personCrumbs } from "@/components/people/PersonView";
import RepresentativeRoles from "@/components/people/RepresentativeRoles";
import PersonEditor from "@/components/people/edit/PersonEditor";
import { readSession } from "@/lib/auth/serverSession";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { loadPerson, loadPersonFresh } from "@/lib/people/fetch";
import { parseEntityId, personEditPath, personPath } from "@/lib/people/paths";
import { personAnchor } from "@/lib/people/primary";
import { personHeading } from "@/lib/people/seo";
import { hueStyle } from "@/lib/people/view";

type PersonEditProps = PageProps<"/[lang]/person/[id]/edit">;

export async function generateMetadata({ params }: PersonEditProps): Promise<Metadata> {
  const robots = { index: false, follow: false };
  const id = parseEntityId((await params).id);
  if (id === null) return { title: { absolute: "AnimeGoClub" }, robots };
  const [{ lang, dict }, person] = await Promise.all([resolveLocale(params), loadPerson(id)]);
  if (!person) return { title: { absolute: "AnimeGoClub" }, robots };
  const name = personHeading(person, lang);
  return { title: { absolute: `${dict.peopleEdit.pageTitle.replace("{{name}}", name)} · AnimeGoClub` }, robots };
}

export default async function PersonEditPage({ params }: PersonEditProps) {
  const id = parseEntityId((await params).id);
  if (id === null) notFound();
  const [{ locale, lang, dict }, exists] = await Promise.all([resolveLocale(params), loadPerson(id)]);
  if (!exists) notFound();
  if (!(await readSession())) redirect(authHrefWithFrom("/login", localizePath(personEditPath(id), locale)));
  const person = await loadPersonFresh(id);
  if (!person) notFound();

  const crumbs = personCrumbs(person, lang, dict).map((c, i, all) =>
    i === all.length - 1 ? { ...c, href: personPath(id) } : c,
  );
  crumbs.push({ label: dict.peopleEdit.crumb });
  return (
    <PersonEditor
      person={person}
      lang={lang}
      crumbs={<Breadcrumbs items={crumbs} label={dict.people.breadcrumb} />}
      representative={<RepresentativeRoles roles={person.representativeRoles} lang={lang} dict={dict} />}
      pageHref={localizePath(personPath(id), locale)}
      hue={hueStyle(personAnchor(person)?.work.posterAccent)}
    />
  );
}
