// /character/[id]: the large portrait, the three names and the aliases
// (AniList's spoiler aliases never reach the page), the profile facts, the
// description with its spoilers collapsed, every voice across languages, and
// the titles the character is on.

import type { ReactNode } from "react";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { pickTitle } from "@/lib/formatters";
import { parseAnilistMarkdown } from "@/lib/people/anilistMarkdown";
import { characterRoleLabel } from "@/lib/people/labels";
import { secondaryNames } from "@/lib/people/names";
import { animeListPath, animePath } from "@/lib/people/paths";
import { primaryAppearance } from "@/lib/people/primary";
import { characterHeading } from "@/lib/people/seo";
import type { Character } from "@/lib/people/types";
import { characterFacts, hueStyle, nativeLanguage } from "@/lib/people/view";
import Appearances from "./Appearances";
import Breadcrumbs, { type Crumb } from "./Breadcrumbs";
import CharacterVoices from "./CharacterVoices";
import ProfileHeader from "./ProfileHeader";
import SpoilerDescription from "./SpoilerDescription";
import s from "./people.module.css";

interface CharacterViewProps {
  character: Character;
  lang: Lang;
  dict: Dict;
  actions?: ReactNode;
}

export function characterCrumbs(character: Character, lang: Lang, dict: Dict): Crumb[] {
  const primary = primaryAppearance(character);
  const crumbs: Crumb[] = [];
  if (primary) {
    crumbs.push({
      label: pickTitle(primary.anime, lang) || primary.anime.titleRomaji || `#${primary.anime.anilistId}`,
      href: animePath(primary.anime.anilistId),
    });
    crumbs.push({
      label: dict.people.breadcrumbCharacters,
      href: animeListPath(primary.anime.anilistId, "characters"),
    });
  }
  crumbs.push({ label: characterHeading(character, lang) });
  return crumbs;
}

export default function CharacterView({ character, lang, dict, actions }: CharacterViewProps) {
  const heading = characterHeading(character, lang);
  const names = secondaryNames(character.name, heading);
  const primary = primaryAppearance(character);
  const role = characterRoleLabel(primary?.role, lang);
  // Parsed here only to know whether there is anything to show: a
  // description that is nothing but an image or a link target leaves no
  // text, and the 简介 heading should not stand over an empty block.
  const description = character.profile?.description?.trim() ?? "";
  const hasDescription = parseAnilistMarkdown(description).length > 0;
  return (
    <main className={`container poster-scope ${s.page}`} style={hueStyle(primary?.anime.posterAccent)}>
      <Breadcrumbs items={characterCrumbs(character, lang, dict)} label={dict.people.breadcrumb} />
      <ProfileHeader
        kind="character"
        image={character.image}
        heading={heading}
        native={names.native}
        nativeLang={nativeLanguage(names.native)}
        romaji={names.full}
        aliases={character.alternativeNames}
        aliasLabel={dict.people.aliases}
        // The role it has in the title the page hangs under; the canvas
        // shows it on a phone, where the titles below are a strip.
        tags={role ? [role] : []}
        facts={characterFacts(character.profile, lang, dict)}
        about={
          hasDescription
            ? { title: dict.people.description, body: <SpoilerDescription markdown={description} /> }
            : null
        }
        actions={actions}
      />
      <CharacterVoices voices={character.voices} lang={lang} dict={dict} />
      <Appearances appearances={character.appearances} lang={lang} dict={dict} />
    </main>
  );
}
