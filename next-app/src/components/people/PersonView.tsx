// /person/[id]: a voice actor or a member of staff — AniList keeps both as
// Staff, and so does this page. Header (photo, names, occupations, facts),
// then 代表角色, 配音作品 by year, and 制作作品 for production credits.
//
// A server component; the two timelines are client leaves for their
// controls. Takes the API's answer and the route's language, reads nothing
// else, so the page it is part of stays ISR-cacheable.

import type { ReactNode } from "react";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { pickTitle } from "@/lib/formatters";
import { secondaryNames } from "@/lib/people/names";
import { animeListPath, animePath } from "@/lib/people/paths";
import { personAnchor } from "@/lib/people/primary";
import { personHeading } from "@/lib/people/seo";
import type { Person } from "@/lib/people/types";
import { hueStyle, nativeLanguage, personFacts, personTags } from "@/lib/people/view";
import Breadcrumbs, { type Crumb } from "./Breadcrumbs";
import ProfileHeader from "./ProfileHeader";
import RepresentativeRoles from "./RepresentativeRoles";
import StaffTimeline from "./StaffTimeline";
import VoiceTimeline from "./VoiceTimeline";
import s from "./people.module.css";

interface PersonViewProps {
  person: Person;
  lang: Lang;
  dict: Dict;
  /** The header's action slot (the edit control, once there is one). */
  actions?: ReactNode;
}

/** The breadcrumb: the title the page hangs under, its list, the person. */
export function personCrumbs(person: Person, lang: Lang, dict: Dict): Crumb[] {
  const anchor = personAnchor(person);
  const crumbs: Crumb[] = [];
  if (anchor) {
    crumbs.push({
      label: pickTitle(anchor.work, lang) || anchor.work.titleRomaji || `#${anchor.work.anilistId}`,
      href: animePath(anchor.work.anilistId),
    });
    crumbs.push({
      label: anchor.list === "characters" ? dict.people.breadcrumbCharacters : dict.people.breadcrumbStaff,
      href: animeListPath(anchor.work.anilistId, anchor.list),
    });
  }
  crumbs.push({ label: personHeading(person, lang) });
  return crumbs;
}

export default function PersonView({ person, lang, dict, actions }: PersonViewProps) {
  const heading = personHeading(person, lang);
  const names = secondaryNames(person.name, heading);
  const anchor = personAnchor(person);
  return (
    <main className={`container poster-scope ${s.page}`} style={hueStyle(anchor?.work.posterAccent)}>
      <Breadcrumbs items={personCrumbs(person, lang, dict)} label={dict.people.breadcrumb} />
      <ProfileHeader
        kind="person"
        image={person.image}
        heading={heading}
        native={names.native}
        nativeLang={nativeLanguage(names.native, person.profile?.language)}
        romaji={names.full}
        tags={personTags(person, lang)}
        facts={personFacts(person.profile, lang, dict)}
        actions={actions}
      />
      <RepresentativeRoles roles={person.representativeRoles} lang={lang} dict={dict} />
      {person.voiceWorkCount > 0 ? (
        <VoiceTimeline years={person.voiceRoles} workCount={person.voiceWorkCount} />
      ) : null}
      {person.staffWorkCount > 0 ? (
        <StaffTimeline years={person.staffRoles} workCount={person.staffWorkCount} />
      ) : null}
    </main>
  );
}
