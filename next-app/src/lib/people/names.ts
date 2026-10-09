// Which of a person's or character's three names a page leads with.
//
// The wire carries {full, native, cn} — AniList's romanised and native names
// and Bangumi's simplified Chinese one (go-api/internal/people). These ladders
// are the detail page's (lib/formatters.ts: CHARACTER_NAME_LADDER and
// VOICE_ACTOR_NAME_LADDER) over those three fields, and names.test.ts holds
// them equal to the detail page's pickers in every language: a reader who
// clicks a voice actor on a cast list must land on a page headed by the same
// name the link carried.
//
// Production staff ride the voice-actor ladder, not the detail page's staff
// ladder (which has no Chinese rung because staff had no Chinese name until
// Bangumi's matches arrived): one person page serves both kinds of credit,
// and a person does not change name between their voice roles and their
// storyboards.

import type { Lang } from "@/lib/i18n/lang";
import type { EntityName } from "./types";

type NameField = keyof EntityName;

const CHARACTER_LADDER: Record<Lang, readonly NameField[]> = {
  zh: ["cn", "native", "full"],
  en: ["full", "native", "cn"],
  "zh-Hant": ["cn", "native", "full"],
};

const PERSON_LADDER: Record<Lang, readonly NameField[]> = {
  zh: ["cn", "native", "full"],
  en: ["full", "native", "cn"],
  "zh-Hant": ["cn", "native", "full"],
};

function firstName(name: EntityName, ladder: readonly NameField[]): string {
  for (const field of ladder) {
    const value = name[field]?.trim();
    if (value) return value;
  }
  return "";
}

/** The name a character page or card is headed with; "" when there is none. */
export function characterDisplayName(name: EntityName, lang: Lang): string {
  return firstName(name, CHARACTER_LADDER[lang]);
}

/** The name a person page or credit is headed with; "" when there is none. */
export function personDisplayName(name: EntityName, lang: Lang): string {
  return firstName(name, PERSON_LADDER[lang]);
}

/**
 * The names under the heading: the native one and the romanised one, each
 * dropped when it would only repeat the heading (小林千晃 is the same in
 * Chinese and Japanese) or the line before it.
 */
export function secondaryNames(
  name: EntityName,
  heading: string,
): { native: string | null; full: string | null } {
  const native = name.native?.trim() || null;
  const full = name.full?.trim() || null;
  const shownNative = native && native !== heading ? native : null;
  const shownFull = full && full !== heading && full !== shownNative ? full : null;
  return { native: shownNative, full: shownFull };
}
