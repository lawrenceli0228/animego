// The edit state of a person or character page, as plain data.
//
// A draft is what the inputs hold. It starts as the page shows itself --
// facts in the reader's language where the page translates them (神奈川县,
// 声优, 日配 · 童年) -- and the payload sent to POST /api/edits carries only
// what differs from that start: an untouched field is never sent, so a label
// the page translated is never written back as data. What the reader changes
// goes as they typed it.
//
// Pure, so the diff and the count the bars show (已改 N 处) are tested
// without a browser. go-api diffs again against the page as it is when the
// submission arrives, and that answer is the one that counts.

import type { Lang } from "@/lib/i18n/lang";
import { characterDescription } from "@/lib/people/description";
import { bloodTypeLabel, genderLabel, homeTownLabel, occupationLabels, voiceLine } from "@/lib/people/labels";
import type { Character, FuzzyDate, Person, PersonRef } from "@/lib/people/types";

/** The limits go-api enforces (internal/edits/changes.go), in characters. */
export const LIMITS = {
  name: 100,
  alias: 100,
  aliases: 20,
  occupation: 60,
  occupations: 10,
  gender: 30,
  age: 30,
  bloodType: 10,
  homeTown: 100,
  description: 20000,
  line: 60,
  source: 500,
  note: 500,
} as const;

/** A label shown as a chip, and the value it stands for. */
export interface Chip {
  value: string;
  label: string;
}

/** A proposed photo: a link to fetch, or an upload already scaled down. */
export type PhotoDraft =
  | { kind: "url"; url: string }
  | { kind: "upload"; dataUrl: string; width: number; height: number };

/** One voice row of a character, as the editor holds it. */
export interface VoiceDraft {
  /** The row's key; null for a row being added. */
  key: string | null;
  person: PersonRef;
  /** Who voiced the row when the editor opened; null for an added row. */
  initialPersonId: number | null;
  line: string;
  initialLine: string;
  /**
   * Whether the line is the one the page makes from the credit (日配 · 童年):
   * no line was written for the row. Emptying it changes nothing, since the
   * page shows that line whenever none is written.
   */
  autoLine: boolean;
  removed: boolean;
}

interface CommonDraft {
  id: number;
  nameCn: string;
  nameNative: string;
  nameFull: string;
  gender: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  bloodType: string;
  photo: PhotoDraft | null;
  sourceUrl: string;
  note: string;
}

export interface CharacterDraft extends CommonDraft {
  kind: "character";
  aliases: string[];
  age: string;
  description: string;
  voices: VoiceDraft[];
  /** Each title's role, by the title's AniList id. */
  roles: Record<number, string>;
}

export interface PersonDraft extends CommonDraft {
  kind: "person";
  occupations: Chip[];
  homeTown: string;
}

export type Draft = CharacterDraft | PersonDraft;

const str = (n: number | null | undefined): string => (n === null || n === undefined ? "" : String(n));

function birthParts(birth: FuzzyDate | null | undefined): Pick<CommonDraft, "birthYear" | "birthMonth" | "birthDay"> {
  return { birthYear: str(birth?.year), birthMonth: str(birth?.month), birthDay: str(birth?.day) };
}

/** A character page's draft, as the page shows it. */
export function characterDraft(c: Character, lang: Lang): CharacterDraft {
  const profile = c.profile;
  return {
    kind: "character",
    id: c.anilistId,
    nameCn: c.name.cn ?? "",
    nameNative: c.name.native ?? "",
    nameFull: c.name.full ?? "",
    aliases: [...c.alternativeNames],
    gender: profile?.gender ?? "",
    age: profile?.age ?? "",
    ...birthParts(profile?.birth),
    bloodType: profile?.bloodType ?? "",
    // The description the page shows this reader (Bangumi's or AniList's),
    // so an untouched one is no change.
    description: characterDescription(c, lang)?.text ?? "",
    photo: null,
    voices: c.voices.map((v) => {
      const written = v.line?.trim();
      const line = written || voiceLine(v.language, v.roleNotes, lang);
      return {
        key: v.key,
        person: v.person,
        initialPersonId: v.person.anilistId,
        line,
        initialLine: line,
        autoLine: !written,
        removed: false,
      };
    }),
    roles: Object.fromEntries(c.appearances.map((a) => [a.anime.anilistId, a.role ?? ""])),
    sourceUrl: "",
    note: "",
  };
}

/** A person page's draft, as the page shows it. */
export function personDraft(p: Person, lang: Lang): PersonDraft {
  const profile = p.profile;
  const occupations = profile?.occupations ?? [];
  return {
    kind: "person",
    id: p.anilistId,
    nameCn: p.name.cn ?? "",
    nameNative: p.name.native ?? "",
    nameFull: p.name.full ?? "",
    occupations: occupations.map((o) => ({ value: o, label: occupationLabels([o], lang)[0] ?? o })),
    gender: profile?.gender ?? "",
    ...birthParts(profile?.birth),
    homeTown: homeTownLabel(profile?.homeTown, lang) ?? "",
    bloodType: profile?.bloodType ?? "",
    photo: null,
    sourceUrl: "",
    note: "",
  };
}

/** The three genders the select offers, plus whatever the page holds now. */
export function genderOptions(current: string, lang: Lang): Chip[] {
  const base = ["Male", "Female", "Other"];
  const values = current && !base.includes(current) ? [...base, current] : base;
  return values.map((v) => ({ value: v, label: genderLabel(v, lang) ?? v }));
}

/** The ABO groups, plus whatever the page holds now. */
export function bloodTypeOptions(current: string, lang: Lang): Chip[] {
  const base = ["A", "B", "O", "AB"];
  const values = current && !base.includes(current) ? [...base, current] : base;
  return values.map((v) => ({ value: v, label: bloodTypeLabel(v, lang) ?? v }));
}

const trim = (s: string) => s.trim();
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function cleanList(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of list.map(trim)) if (s && !out.includes(s)) out.push(s);
  return out;
}

/** "1994" → 1994, "" → null; anything else is not a number. */
function part(s: string): number | null | "bad" {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{1,4}$/.test(t)) return "bad";
  return Number(t);
}

export interface BirthValue {
  year: number | null;
  month: number | null;
  day: number | null;
}

type BirthParts = Pick<CommonDraft, "birthYear" | "birthMonth" | "birthDay">;

/**
 * The draft's birthday, or "bad" when a part is not a number or the date
 * cannot exist. A person was born by next year at the latest; a character in
 * any year its story sets (go-api's cleanBirth).
 */
export function birthValue(d: BirthParts, kind: Draft["kind"] = "person"): BirthValue | null | "bad" {
  const year = part(d.birthYear);
  const month = part(d.birthMonth);
  const day = part(d.birthDay);
  if (year === "bad" || month === "bad" || day === "bad") return "bad";
  if (year === null && month === null && day === null) return null;
  if (month !== null && (month < 1 || month > 12)) return "bad";
  const [minYear, maxYear] = kind === "person" ? [1000, new Date().getFullYear() + 1] : [1, 9999];
  if (year !== null && (year < minYear || year > maxYear)) return "bad";
  if (day !== null) {
    if (month === null) return "bad";
    const last = new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();
    if (day < 1 || day > last) return "bad";
  }
  return { year, month, day };
}

/** Whether a source is an http(s) link with a host. */
export function validSource(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > LIMITS.source) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The "changes" object of POST /api/edits, and how many places it changes. */
export interface Changes {
  changes: Record<string, unknown>;
  count: number;
  /** A name emptied or a birthday that cannot be: nothing can be sent. */
  invalid: boolean;
}

function textChange(changes: Record<string, unknown>, key: string, initial: string, next: string, clearable: boolean): number {
  const a = initial.trim();
  const b = next.trim();
  if (a === b) return 0;
  changes[key] = b === "" && clearable ? null : b;
  return 1;
}

const sameBirth = (a: BirthParts, b: BirthParts) =>
  a.birthYear.trim() === b.birthYear.trim() &&
  a.birthMonth.trim() === b.birthMonth.trim() &&
  a.birthDay.trim() === b.birthDay.trim();

/**
 * A credited voice row's line as it is to be sent: undefined when unchanged
 * (an emptied line the page makes from the credit included), null to go
 * back to that line, or the line written.
 */
export function voiceLineChange(v: VoiceDraft): string | null | undefined {
  const next = v.line.trim();
  if (next === v.initialLine.trim()) return undefined;
  if (next === "") return v.autoLine ? undefined : null;
  return next;
}

/**
 * What differs between the draft as it opened and as it is now.
 *
 * Names cannot be cleared (go-api refuses it): emptying one that had a value
 * makes the draft invalid instead of a change. The facts clear to null.
 */
export function diffDraft(initial: Draft, current: Draft): Changes {
  const changes: Record<string, unknown> = {};
  let count = 0;
  let invalid = false;

  for (const key of ["nameCn", "nameNative", "nameFull"] as const) {
    if (current[key].trim() === "" && initial[key].trim() !== "") invalid = true;
    else count += textChange(changes, key, initial[key], current[key], false);
  }
  if (current.photo) {
    changes.image = current.photo.kind === "url" ? { url: current.photo.url.trim() } : { dataUrl: current.photo.dataUrl };
    count++;
  }
  count += textChange(changes, "gender", initial.gender, current.gender, true);
  count += textChange(changes, "bloodType", initial.bloodType, current.bloodType, true);

  // Checked only once changed: the data can hold a date the editor would
  // refuse, and leaving it alone must not block the rest of the edit.
  if (!sameBirth(initial, current)) {
    const after = birthValue(current, current.kind);
    if (after === "bad") {
      invalid = true;
    } else if (JSON.stringify(birthValue(initial, initial.kind)) !== JSON.stringify(after)) {
      changes.birth = after;
      count++;
    }
  }

  if (initial.kind === "character" && current.kind === "character") {
    const aliases = cleanList(current.aliases);
    if (!sameList(cleanList(initial.aliases), aliases)) {
      changes.aliases = aliases;
      count++;
    }
    count += textChange(changes, "age", initial.age, current.age, true);
    count += textChange(changes, "description", initial.description, current.description, true);

    const voices: Record<string, unknown>[] = [];
    for (const v of current.voices) {
      if (v.key === null) {
        if (v.removed) continue;
        voices.push({ personId: v.person.anilistId, ...(v.line.trim() ? { line: v.line.trim() } : {}) });
        continue;
      }
      if (v.removed) {
        voices.push({ key: v.key, remove: true });
        continue;
      }
      const change: Record<string, unknown> = { key: v.key };
      if (v.person.anilistId !== v.initialPersonId) change.personId = v.person.anilistId;
      const line = voiceLineChange(v);
      if (line !== undefined) change.line = line;
      if (Object.keys(change).length > 1) voices.push(change);
    }
    if (voices.length > 0) {
      changes.voices = voices;
      count += voices.length;
    }

    const roles = Object.entries(current.roles)
      .filter(([animeId, role]) => role && role !== initial.roles[Number(animeId)])
      .map(([animeId, role]) => ({ animeId: Number(animeId), role }));
    if (roles.length > 0) {
      changes.roles = roles;
      count += roles.length;
    }
  }

  if (initial.kind === "person" && current.kind === "person") {
    const occupations = cleanList(current.occupations.map((c) => c.value));
    if (!sameList(cleanList(initial.occupations.map((c) => c.value)), occupations)) {
      changes.occupations = occupations;
      count++;
    }
    count += textChange(changes, "homeTown", initial.homeTown, current.homeTown, true);
  }

  return { changes, count, invalid };
}

/** The body of POST /api/edits for a draft. */
export function submissionBody(current: Draft, changes: Record<string, unknown>) {
  return {
    kind: current.kind,
    entityId: current.id,
    sourceUrl: current.sourceUrl.trim(),
    ...(current.note.trim() ? { note: current.note.trim() } : {}),
    changes,
  };
}

/**
 * The person a "replace" or "add voice" lookup names: an AniList staff link,
 * a link to this site's person page (any locale), or the bare id.
 */
export function personIdFromInput(raw: string): number | null {
  const s = raw.trim();
  const m = /^(\d{1,10})$/.exec(s) ?? /(?:\/staff\/|\/person\/)(\d{1,10})(?:[/?#]|$)/.exec(s);
  if (!m) return null;
  const id = Number(m[1]);
  return id > 0 && id <= 2_147_483_647 ? id : null;
}
