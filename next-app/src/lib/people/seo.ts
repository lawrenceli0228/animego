// What search engines read on the person and character pages: <title>, the
// meta description, and JSON-LD. Server-only (it reads the server
// dictionary's templates).
//
// Titles name the page in the reader's language with the native name beside
// it when that is a different string — "花泽香菜（花澤香菜）" is two queries
// people type — and say what the page is about: a voice actor, staff, or the
// title a character comes from. Descriptions are written from the page's own
// facts rather than taken from AniList, whose descriptions are English.
//
// JSON-LD: a Person for people, with the AniList and Bangumi pages as sameAs
// (the disambiguation signal), and a BreadcrumbList for both. A character gets
// no entity: schema.org has no type for a fictional character, and calling one
// a Person would be a claim the page cannot stand behind.

import { fill, type Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import type { Locale } from "@/lib/i18n/locale";
import { pickSeoTitle, truncate } from "@/lib/formatters";
import { absoluteUrl } from "@/lib/seo/alternates";
import { isoProfileDate } from "./dates";
import { characterRoleLabel } from "./labels";
import { characterDisplayName, personDisplayName } from "./names";
import { animeListPath, animePath, personPath } from "./paths";
import { personAnchor, primaryAppearance } from "./primary";
import type { Appearance, Character, EntityName, PeopleWork, Person } from "./types";

/** Google shows about this much of a description. */
const META_DESCRIPTION_LENGTH = 160;

/** How the parts of a sentence list are joined, and sentences to each other. */
const LIST_SEPARATOR: Record<Lang, string> = { zh: "、", en: ", ", "zh-Hant": "、" };
const SENTENCE_SEPARATOR: Record<Lang, string> = { zh: "", en: " ", "zh-Hant": "" };
/** "修塔尔克（葬送的芙莉莲）" / "Stark (Frieren)". */
const IN_TITLE: Record<Lang, (name: string, title: string) => string> = {
  zh: (n, t) => `${n}（${t}）`,
  en: (n, t) => `${n} (${t})`,
  "zh-Hant": (n, t) => `${n}（${t}）`,
};

const SITE = "AnimeGoClub";

function withNative(heading: string, name: EntityName, dict: Dict): string {
  const native = name.native?.trim();
  return native && native !== heading ? fill(dict.people.nameWithNative, { name: heading, native }) : heading;
}

function workTitle(work: PeopleWork, lang: Lang): string {
  return pickSeoTitle(work, lang) || work.titleRomaji || "";
}

/** What the person is to the reader: a voice actor if they voice anything. */
function personRole(person: Pick<Person, "voiceWorkCount">, dict: Dict): string {
  return person.voiceWorkCount > 0 ? dict.people.voiceActor : dict.people.staffMember;
}

export function personHeading(person: Pick<Person, "name" | "anilistId">, lang: Lang): string {
  return personDisplayName(person.name, lang) || `#${person.anilistId}`;
}

export function characterHeading(character: Pick<Character, "name" | "anilistId">, lang: Lang): string {
  return characterDisplayName(character.name, lang) || `#${character.anilistId}`;
}

export function personMetaTitle(person: Person, lang: Lang, dict: Dict): string {
  return [withNative(personHeading(person, lang), person.name, dict), personRole(person, dict), SITE].join(" · ");
}

export function personMetaDescription(person: Person, lang: Lang, dict: Dict): string {
  const heading = personHeading(person, lang);
  const sentences = [fill(dict.people.metaIntro, { name: heading, role: personRole(person, dict) })];
  const known = person.representativeRoles
    .map((r) => IN_TITLE[lang](characterDisplayName(r.character.name, lang), workTitle(r.anime, lang)))
    .filter(Boolean);
  if (known.length > 0) sentences.push(fill(dict.people.metaKnownFor, { roles: known.join(LIST_SEPARATOR[lang]) }));
  if (person.voiceWorkCount > 0) sentences.push(fill(dict.people.metaVoiceCount, { n: person.voiceWorkCount }));
  else if (person.staffWorkCount > 0) sentences.push(fill(dict.people.metaStaffCount, { n: person.staffWorkCount }));
  return truncate(sentences.join(SENTENCE_SEPARATOR[lang]), META_DESCRIPTION_LENGTH);
}

export function characterMetaTitle(character: Character, primary: Appearance | null, lang: Lang, dict: Dict): string {
  const parts = [withNative(characterHeading(character, lang), character.name, dict)];
  const title = primary ? workTitle(primary.anime, lang) : "";
  if (title) parts.push(title);
  parts.push(SITE);
  return parts.join(" · ");
}

export function characterMetaDescription(
  character: Character,
  primary: Appearance | null,
  lang: Lang,
  dict: Dict,
): string {
  const heading = characterHeading(character, lang);
  const sentences: string[] = [];
  if (primary) {
    sentences.push(
      fill(dict.people.metaCharacterIntro, {
        name: heading,
        title: workTitle(primary.anime, lang),
        role: characterRoleLabel(primary.role, lang) ?? "",
      }),
    );
  }
  const voices = [...new Set(character.voices.map((v) => personDisplayName(v.person.name, lang)).filter(Boolean))];
  if (voices.length > 0) {
    sentences.push(fill(dict.people.metaCharacterVoices, { names: voices.slice(0, 3).join(LIST_SEPARATOR[lang]) }));
  }
  sentences.push(fill(dict.people.metaCharacterWorks, { n: character.appearances.length }));
  return truncate(sentences.join(SENTENCE_SEPARATOR[lang]), META_DESCRIPTION_LENGTH);
}

// ── JSON-LD ───────────────────────────────────────────────────────────────

export interface JsonLdPerson {
  "@context": "https://schema.org";
  "@type": "Person";
  name: string;
  url: string;
  alternateName?: string[];
  image?: string;
  birthDate?: string;
  deathDate?: string;
  gender?: string;
  jobTitle?: string[];
  sameAs?: string[];
}

/**
 * A Person for /person/[id]. Every value is one the page shows or links to;
 * fields AniList does not have are absent rather than empty.
 */
export function personJsonLd(person: Person, lang: Lang, locale: Locale): JsonLdPerson {
  const name = personHeading(person, lang);
  const ld: JsonLdPerson = {
    "@context": "https://schema.org",
    "@type": "Person",
    name,
    url: absoluteUrl(personPath(person.anilistId), locale),
  };
  // The page's own names only. AniList's alternative names for a person are
  // the pseudonyms they work under, adult work included; the API does not
  // send them.
  const others = [person.name.cn, person.name.native, person.name.full]
    .map((n) => n?.trim())
    .filter((n): n is string => !!n && n !== name);
  if (others.length > 0) ld.alternateName = [...new Set(others)];
  if (person.image) ld.image = person.image;
  const profile = person.profile;
  const born = isoProfileDate(profile?.birth);
  if (born) ld.birthDate = born;
  const died = isoProfileDate(profile?.death);
  if (died) ld.deathDate = died;
  // schema.org's GenderType has Male and Female; anything else stays off.
  if (profile?.gender === "Male" || profile?.gender === "Female") ld.gender = profile.gender;
  if (profile && profile.occupations.length > 0) ld.jobTitle = profile.occupations;
  const sameAs = [
    profile?.siteUrl ?? null,
    person.bangumiId ? `https://bgm.tv/person/${person.bangumiId}` : null,
  ].filter((u): u is string => !!u);
  if (sameAs.length > 0) ld.sameAs = sameAs;
  return ld;
}

export interface BreadcrumbStep {
  name: string;
  /** Root-relative, unprefixed; omitted for the page itself. */
  path?: string;
}

export interface JsonLdBreadcrumbList {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: Array<{ "@type": "ListItem"; position: number; name: string; item?: string }>;
}

/** Home › the title › its list › the page, as absolute URLs in this locale. */
export function breadcrumbJsonLd(steps: BreadcrumbStep[], locale: Locale): JsonLdBreadcrumbList {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: steps.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: s.name,
      ...(s.path ? { item: absoluteUrl(s.path, locale) } : {}),
    })),
  };
}


// ── Breadcrumb steps ──────────────────────────────────────────────────────


/** The JSON-LD trail for a person page: home, the title, its list, the person. */
export function personBreadcrumbSteps(person: Person, lang: Lang, dict: Dict): BreadcrumbStep[] {
  const steps: BreadcrumbStep[] = [{ name: dict.nav.home, path: "/" }];
  const anchor = personAnchor(person);
  if (anchor) {
    steps.push({ name: workTitle(anchor.work, lang), path: animePath(anchor.work.anilistId) });
    steps.push({
      name: anchor.list === "characters" ? dict.people.breadcrumbCharacters : dict.people.breadcrumbStaff,
      path: animeListPath(anchor.work.anilistId, anchor.list),
    });
  }
  steps.push({ name: personHeading(person, lang) });
  return steps;
}

/** The JSON-LD trail for a character page. */
export function characterBreadcrumbSteps(character: Character, lang: Lang, dict: Dict): BreadcrumbStep[] {
  const steps: BreadcrumbStep[] = [{ name: dict.nav.home, path: "/" }];
  const primary = primaryAppearance(character);
  if (primary) {
    steps.push({ name: workTitle(primary.anime, lang), path: animePath(primary.anime.anilistId) });
    steps.push({ name: dict.people.breadcrumbCharacters, path: animeListPath(primary.anime.anilistId, "characters") });
  }
  steps.push({ name: characterHeading(character, lang) });
  return steps;
}
