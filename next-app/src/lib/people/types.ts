// Wire shapes of GET /api/people/:id and GET /api/characters/:id
// (go-api/internal/people/dto.go). Kept apart from lib/types.ts, which is the
// anime detail's contract: these are a separate surface with their own
// owner, and nothing outside the person and character pages reads them.

import type { FuzzyDate } from "@/lib/formatters";

export type { FuzzyDate };

/**
 * The three names a person or character can have, each null when nobody has
 * it: AniList's romanised `full` and `native`, and Bangumi's simplified
 * Chinese `cn`. Which one leads is the page's decision, per language — see
 * lib/people/names.ts.
 */
export interface EntityName {
  full: string | null;
  native: string | null;
  cn: string | null;
}

/** A title as these pages list it. Field names match the anime detail's. */
export interface PeopleWork {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  titleHant: string | null;
  titleHantSeo: string | null;
  coverImageUrl: string | null;
  format: string | null;
  /** The start date's year, else the season year; null when AniList has neither. */
  year: number | null;
  popularity: number | null;
  posterAccent: string | null;
}

export interface CharacterRef {
  anilistId: number;
  name: EntityName;
  image: string | null;
}

export interface PersonRef {
  anilistId: number;
  name: EntityName;
  image: string | null;
}

/** MAIN | SUPPORTING | BACKGROUND, as AniList spells them. */
export type CharacterRole = string;

export interface VoiceRole {
  character: CharacterRef;
  anime: PeopleWork;
  role: CharacterRole | null;
  /** AniList's languageV2 label: "Japanese", "Chinese", "Korean", … */
  language: string | null;
  /** AniList's free-text note, "Childhood" and the like; null for the main voice. */
  roleNotes: string | null;
}

export interface VoiceYear {
  /** Null for titles AniList has no date for; that group comes first. */
  year: number | null;
  roles: VoiceRole[];
}

export interface StaffWork {
  anime: PeopleWork;
  /** AniList's role strings in credit order, e.g. "Storyboard (eps 1, 5)". */
  roles: string[];
}

export interface StaffYear {
  year: number | null;
  works: StaffWork[];
}

export interface PersonProfile {
  occupations: string[];
  gender: string | null;
  birth: FuzzyDate | null;
  death: FuzzyDate | null;
  age: number | null;
  yearsActive: number[];
  homeTown: string | null;
  bloodType: string | null;
  language: string | null;
  siteUrl: string | null;
}

export interface Person {
  anilistId: number;
  bangumiId: number | null;
  name: EntityName;
  image: string | null;
  /** Null until the profiles sweep has fetched this person from AniList. */
  profile: PersonProfile | null;
  representativeRoles: VoiceRole[];
  voiceRoles: VoiceYear[];
  staffRoles: StaffYear[];
  voiceWorkCount: number;
  staffWorkCount: number;
  indexable: boolean;
}

export interface CharacterProfile {
  /** AniList markdown, spoiler markers (~!…!~) included. See anilistMarkdown.ts. */
  description: string | null;
  gender: string | null;
  /** Free text on AniList: "17-18", "1000+". */
  age: string | null;
  birth: FuzzyDate | null;
  bloodType: string | null;
  siteUrl: string | null;
}

export interface CharacterVoice {
  /**
   * The row's name for an edit: "<personId>|<language>|<notes>" for a row the
   * credits list, "add:<personId>" for one an accepted edit added. It stays
   * the credit's key after an edit gives the row to someone else.
   */
  key: string;
  person: PersonRef;
  language: string | null;
  roleNotes: string | null;
  /** The line under the name as an accepted edit wrote it; shown instead of language · notes. */
  line: string | null;
}

export interface Appearance {
  anime: PeopleWork;
  role: CharacterRole | null;
}

export interface Character {
  anilistId: number;
  bangumiId: number | null;
  name: EntityName;
  alternativeNames: string[];
  image: string | null;
  profile: CharacterProfile | null;
  /**
   * Bangumi's summary (go-api 0048), in the description markup the profile's
   * uses; null when Bangumi has none, or when an accepted edit set the
   * description. lib/people/description.ts picks between the two.
   */
  bangumiDescription: string | null;
  voices: CharacterVoice[];
  /** Earliest first. */
  appearances: Appearance[];
  indexable: boolean;
}

/** One row of /api/people/sitemap or /api/characters/sitemap. */
export interface SitemapEntity {
  anilistId: number;
  updatedAt: string;
}
