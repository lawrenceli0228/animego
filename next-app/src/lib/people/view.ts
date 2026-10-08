// What the person and character views derive from the API's answer before
// rendering: the facts grid, the tags, the native name's language, the page
// colour. Pure, so it is tested without React.

import type { CSSProperties } from "react";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { hueFromHex } from "@/lib/oklch";
import { formatProfileDate } from "./dates";
import { bloodTypeLabel, genderLabel, homeTownLabel, occupationLabels } from "./labels";
import type { CharacterProfile, Person, PersonProfile } from "./types";

export interface FactRow {
  label: string;
  value: string | null;
}

/**
 * 生日 · 性别 / 出身地 · 血型, the canvas's order, and 忌日 when AniList
 * has one (a birthday alone on a page about someone who has died reads as
 * if they had not). Undefined without a profile: four em dashes say nothing
 * a missing grid does not.
 */
export function personFacts(profile: PersonProfile | null, lang: Lang, dict: Dict): FactRow[] | undefined {
  if (!profile) return undefined;
  const rows: FactRow[] = [
    { label: dict.people.birthday, value: formatProfileDate(profile.birth, lang) },
    { label: dict.people.gender, value: genderLabel(profile.gender, lang) },
    { label: dict.people.homeTown, value: homeTownLabel(profile.homeTown, lang) },
    { label: dict.people.bloodType, value: bloodTypeLabel(profile.bloodType, lang) },
  ];
  const died = formatProfileDate(profile.death, lang);
  if (died) rows.push({ label: dict.people.died, value: died });
  return rows;
}

/** 性别 · 年龄 / 生日 · 血型, the canvas's order. */
export function characterFacts(profile: CharacterProfile | null, lang: Lang, dict: Dict): FactRow[] | undefined {
  if (!profile) return undefined;
  return [
    { label: dict.people.gender, value: genderLabel(profile.gender, lang) },
    { label: dict.people.age, value: profile.age?.trim() || null },
    { label: dict.people.birthday, value: formatProfileDate(profile.birth, lang) },
    { label: dict.people.bloodType, value: bloodTypeLabel(profile.bloodType, lang) },
  ];
}

/**
 * The tags under a person's name: AniList's occupations, translated. Before
 * the profile sweep reaches them, a person credited with voices is still
 * tagged as a voice actor — the credits say so — and staff get no tag rather
 * than a guess at which kind of staff.
 */
export function personTags(person: Pick<Person, "profile" | "voiceWorkCount">, lang: Lang): string[] {
  if (person.profile && person.profile.occupations.length > 0) {
    return occupationLabels(person.profile.occupations, lang);
  }
  return person.voiceWorkCount > 0 ? occupationLabels(["Voice Actor"], lang) : [];
}

const LANGUAGE_CODE: Record<string, "ja" | "zh" | "ko"> = {
  Japanese: "ja",
  Chinese: "zh",
  Korean: "ko",
};

/**
 * The language of a native name: the profile's, when AniList gives one,
 * else what the script shows — kana is Japanese, hangul Korean. Han alone
 * says nothing (小林千晃 and 魏无羡 are both Han), so it stays unknown.
 */
export function nativeLanguage(native: string | null, language?: string | null): "ja" | "zh" | "ko" | null {
  if (language && LANGUAGE_CODE[language]) return LANGUAGE_CODE[language];
  if (!native) return null;
  if (/[぀-ヿ]/.test(native)) return "ja";
  if (/[가-힯]/.test(native)) return "ko";
  return null;
}

/**
 * The page's colour, from the cover of the title it hangs under: the hue
 * only, set on the element that also carries `.poster-scope` (globals.css
 * rebuilds the tone ramp there). Undefined — the site's fallback hue — for a
 * title with no accent or a grey one.
 */
export function hueStyle(posterAccent: string | null | undefined): CSSProperties | undefined {
  const hue = hueFromHex(posterAccent);
  if (hue === null) return undefined;
  return { "--poster-hue": hue.toFixed(1) } as CSSProperties;
}
