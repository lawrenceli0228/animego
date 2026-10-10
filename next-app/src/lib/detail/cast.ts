// What the 角色 tab says about a character, and the label tables the overview
// shares with it. Pure, DOM-free and dictionary-free: the client component,
// the server page and a bun test all import it.

import { pickCharacterName, pickVoiceActorName } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n/lang";
import { characterPath, personPath } from "@/lib/people/paths";
import type { CastCharacter, CastRoleCounts, CastVoice, DubLanguage } from "@/lib/types";

/** AniList's character roles, as each language names them. */
export const CHARACTER_ROLE_LABEL: Record<Lang, Record<string, string>> = {
  zh: { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
  en: { MAIN: "Main", SUPPORTING: "Supporting", BACKGROUND: "Background" },
  // All three are script-identical — no conversion needed, only a row.
  "zh-Hant": { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
};

/**
 * The label for a character's role. A row with no role reads as supporting —
 * the overview always has — and a role AniList adds later shows as AniList
 * spells it rather than as nothing.
 */
export function characterRoleLabel(role: string | null | undefined, lang: Lang): string {
  const key = role?.trim().toUpperCase() || "SUPPORTING";
  return CHARACTER_ROLE_LABEL[lang][key] ?? key;
}

/**
 * A dub's name: 日配 / 中配 / 韩配. The credits keep Japanese voices only, so
 * 日配 is the one shown (under each voice, and on the switch, which is drawn
 * only when a title has more than one dub); the other two stay for the codes
 * the API still accepts.
 */
export const DUB_LABEL: Record<Lang, Record<DubLanguage, string>> = {
  zh: { ja: "日配", zh: "中配", ko: "韩配" },
  en: { ja: "Japanese", zh: "Chinese", ko: "Korean" },
  "zh-Hant": { ja: "日配", zh: "中配", ko: "韓配" },
};

/**
 * AniList's role notes for a second voice. The common ones are translated;
 * anything else ("eps 511", "Female") is shown as AniList wrote it, which is
 * still more than nothing.
 */
const VOICE_NOTE_LABEL: Record<Lang, Record<string, string>> = {
  zh: { childhood: "童年", child: "童年", young: "少年" },
  en: {},
  "zh-Hant": { childhood: "童年", child: "童年", young: "少年" },
};

export function voiceNoteLabel(note: string, lang: Lang): string {
  return VOICE_NOTE_LABEL[lang][note.trim().toLowerCase()] ?? note.trim();
}

/** One card, ready to render. */
export interface CastCardView {
  key: string;
  name: string;
  /** The character's other name, when it has one that differs. */
  altName: string | null;
  roleLabel: string;
  isMain: boolean;
  imageUrl: string | null;
  /** The character's page; null for a row with no AniList id. */
  href: string | null;
  /** The main voice in the dub shown; null when the character has none in it. */
  voice: { name: string; altName: string | null; imageUrl: string | null; href: string | null } | null;
  /** Under the voice: the dub (日配), or the second voice (童年 · 某某). */
  note: string;
}

function firstOther(primary: string, candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v !== primary) return v;
  }
  return null;
}

function voiceName(v: CastVoice, lang: Lang): string {
  return pickVoiceActorName(
    { voiceActorCn: v.nameCn, voiceActorJa: v.nameNative, voiceActorEn: v.nameFull },
    lang,
  );
}

/**
 * The card for one character in one dub.
 *
 * Names follow the site's ladders (pickCharacterName / pickVoiceActorName:
 * zh reads the Chinese name, then the Japanese, then the romaji); the line
 * under a name is the next different name down the other way — Japanese
 * under Chinese, romaji under a Japanese name with no Chinese one.
 *
 * `index` is the card's position, for the key of a row with no AniList id.
 */
export function castCardView(c: CastCharacter, dub: DubLanguage, lang: Lang, index: number): CastCardView {
  const name = pickCharacterName(c, lang) || "—";
  const [main, second] = c.voices;
  const dubLabel = DUB_LABEL[lang][dub];

  let note = "";
  if (second) {
    const label = second.roleNotes ? voiceNoteLabel(second.roleNotes, lang) : dubLabel;
    note = `${label} · ${voiceName(second, lang) || "—"}`;
  } else if (main) {
    note = main.roleNotes ? `${dubLabel} · ${voiceNoteLabel(main.roleNotes, lang)}` : dubLabel;
  }

  const mainName = main ? voiceName(main, lang) || "—" : "";
  return {
    key: c.characterId != null ? `c${c.characterId}` : `i${index}`,
    name,
    altName: firstOther(name, [c.nameJa, c.nameEn, c.nameCn]),
    roleLabel: characterRoleLabel(c.role, lang),
    isMain: c.role?.trim().toUpperCase() === "MAIN",
    imageUrl: c.imageUrl,
    href: c.characterId != null ? characterPath(c.characterId) : null,
    voice: main
      ? {
          name: mainName,
          altName: firstOther(mainName, [main.nameNative, main.nameFull, main.nameCn]),
          imageUrl: main.imageUrl,
          href: main.staffId != null ? personPath(main.staffId) : null,
        }
      : null,
    note,
  };
}

/**
 * The list on screen with the next page added after it.
 *
 * Pages are offsets into a list the server holds, and the first page is the
 * one baked into the cached HTML: if the list changed in between, an offset
 * can land one character early and repeat the last card. A character already
 * shown is dropped. Rows with no AniList id cannot be told apart and are kept.
 */
export function appendCastPage(shown: readonly CastCharacter[], next: readonly CastCharacter[]): CastCharacter[] {
  const seen = new Set(shown.map((c) => c.characterId).filter((id): id is number => id != null));
  return [...shown, ...next.filter((c) => c.characterId == null || !seen.has(c.characterId))];
}

/** The role filter: 全部 / 主角 / 配角 / 客串. */
export type RoleFilter = "all" | "main" | "supporting" | "background";

export const ROLE_FILTERS: readonly RoleFilter[] = ["all", "main", "supporting", "background"];

export function roleCount(counts: CastRoleCounts, filter: RoleFilter): number {
  return counts[filter];
}

/** How many cards the server renders, and how many each 「再显示」 adds. */
export const CAST_FIRST_PAGE = 24;
export const CAST_MORE_PAGE = 48;

/**
 * The query string for /api/anime/:id/characters, naming only what differs
 * from the endpoint's defaults (all roles, the default dub, no search,
 * offset 0). `limit` is always sent: the endpoint's default is a server
 * constant this module should not have to agree with.
 */
export function charactersQuery(input: {
  role: RoleFilter;
  dub: DubLanguage | null;
  q: string;
  offset: number;
  limit: number;
}): string {
  const params = new URLSearchParams();
  if (input.role !== "all") params.set("role", input.role);
  if (input.dub) params.set("lang", input.dub);
  const q = input.q.trim();
  if (q) params.set("q", q);
  if (input.offset > 0) params.set("offset", String(input.offset));
  params.set("limit", String(input.limit));
  return params.toString();
}
