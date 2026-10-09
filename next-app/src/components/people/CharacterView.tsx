// /character/[id]: the large portrait, the three names and the aliases
// (AniList's spoiler aliases never reach the page), the profile facts, the
// description with its spoilers collapsed, every voice across languages, and
// the titles the character is on.

import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { pickTitle } from "@/lib/formatters";
import { characterDescription } from "@/lib/people/description";
import { characterRoleLabel } from "@/lib/people/labels";
import { secondaryNames } from "@/lib/people/names";
import { animeListPath, animePath, characterEditPath } from "@/lib/people/paths";
import { primaryAppearance } from "@/lib/people/primary";
import { characterHeading } from "@/lib/people/seo";
import type { Character } from "@/lib/people/types";
import { characterFacts, hueStyle, nativeLanguage } from "@/lib/people/view";
import Appearances from "./Appearances";
import Breadcrumbs, { type Crumb } from "./Breadcrumbs";
import EditLink from "./EditLink";
import CharacterVoices from "./CharacterVoices";
import ProfileHeader from "./ProfileHeader";
import SpoilerDescription from "./SpoilerDescription";
import s from "./people.module.css";

interface CharacterViewProps {
  character: Character;
  lang: Lang;
  dict: Dict;
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

export default function CharacterView({ character, lang, dict }: CharacterViewProps) {
  const heading = characterHeading(character, lang);
  const names = secondaryNames(character.name, heading);
  const primary = primaryAppearance(character);
  const role = characterRoleLabel(primary?.role, lang);
  // Bangumi's summary for a Chinese reader, AniList's for an English one,
  // each standing in for the other; null when neither has any text, so the
  // 简介 heading never stands over an empty block.
  const description = characterDescription(character, lang);
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
          description
            ? {
                title: dict.people.description,
                body: (
                  <>
                    <SpoilerDescription markdown={description.text} lang={description.lang} />
                    {/* Credited as the title's synopsis is when it is Bangumi's. */}
                    {description.source === "bangumi" ? (
                      <p className={s.descriptionSource}>
                        {character.bangumiId ? (
                          <a href={`https://bgm.tv/character/${character.bangumiId}`} target="_blank" rel="noopener noreferrer">
                            {dict.detail.summaryFromBangumi}
                          </a>
                        ) : (
                          dict.detail.summaryFromBangumi
                        )}
                      </p>
                    ) : null}
                  </>
                ),
              }
            : null
        }
        actions={<EditLink href={characterEditPath(character.anilistId)} label={dict.people.edit} />}
      />
      <CharacterVoices voices={character.voices} lang={lang} dict={dict} />
      <Appearances appearances={character.appearances} lang={lang} dict={dict} />
    </main>
  );
}
