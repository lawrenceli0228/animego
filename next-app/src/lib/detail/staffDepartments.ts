// The 制作 tab's departments: which department a credit belongs to, how a
// title's credits group into people per department, and the search over
// them.
//
// Pure, DOM-free and dictionary-free, so the client component and a bun test
// can both import it. The department names live here as a label table, the
// way the role and relation labels do in lib/contentLabels.ts: they are a
// closed vocabulary keyed by code, not UI copy.
//
// The API answers AniList's role text untouched — "Storyboard (eps 1, 2)",
// "Theme Song Performance (Spanish; OP2)" — one credit per person per role.
// Grouping happens here, next to staffRoleLabel, which the rows use for the
// role text itself.

import { normalizeStaffRole, staffRoleLabel } from "@/lib/contentLabels";
import type { Lang } from "@/lib/i18n/lang";
import type { StaffCredit } from "@/lib/types";

export type DepartmentKey =
  | "original"
  | "direction"
  | "script"
  | "design"
  | "animation"
  | "keyAnimation"
  | "art"
  | "color"
  | "photography"
  | "editing"
  | "music"
  | "sound"
  | "production"
  | "other";

/** Every department, in the order the tab lists them. */
export const DEPARTMENTS: readonly DepartmentKey[] = [
  "original",
  "direction",
  "script",
  "design",
  "animation",
  "keyAnimation",
  "art",
  "color",
  "photography",
  "editing",
  "music",
  "sound",
  "production",
  "other",
];

export const DEPARTMENT_LABEL: Record<Lang, Record<DepartmentKey, string>> = {
  zh: {
    original: "原作",
    direction: "监督与演出",
    script: "系列构成 / 脚本",
    design: "人设与设定",
    animation: "作画",
    keyAnimation: "原画与动画",
    art: "美术",
    color: "色彩",
    photography: "摄影与 CG",
    editing: "剪辑",
    music: "音乐",
    sound: "音响",
    production: "制作",
    other: "其他",
  },
  en: {
    original: "Original work",
    direction: "Direction",
    script: "Script",
    design: "Design",
    animation: "Animation direction",
    keyAnimation: "Key & in-between animation",
    art: "Art",
    color: "Color",
    photography: "Photography & CG",
    editing: "Editing",
    music: "Music",
    sound: "Sound",
    production: "Production",
    other: "Other",
  },
  "zh-Hant": {
    original: "原作",
    direction: "監督與演出",
    script: "系列構成 / 腳本",
    design: "人設與設定",
    animation: "作畫",
    keyAnimation: "原畫與動畫",
    art: "美術",
    color: "色彩",
    photography: "攝影與 CG",
    editing: "剪輯",
    music: "音樂",
    sound: "音響",
    production: "製作",
    other: "其他",
  },
};

/**
 * The role a credit names, without what follows it in parentheses.
 *
 * normalizeStaffRole strips the qualifiers it knows to be episode or song
 * lists, and only when they are closed — but AniList cuts long role strings
 * off mid-list ("Animation Director (eps 2, 9, 14, … 1"), and a department
 * does not care about "(English)" either. Everything from the first " (" on
 * is dropped.
 */
function baseRole(role: string): string {
  const cut = role.indexOf("(");
  return (cut === -1 ? role : role.slice(0, cut)).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * First match wins, so the order is the rule as much as the patterns are:
 * "Color Script" is colour before it is script, "Sound Production" is sound
 * before it is production, "Art Director" is art before it is direction,
 * "Title Logo Design" is promotion before it is design, and "Key Animation"
 * is key animation before it is animation direction.
 */
const RULES: ReadonlyArray<readonly [RegExp, DepartmentKey]> = [
  [/^original\b/, "original"],
  [/\bcolou?r\b|\bfinishing\b|\bpaint/, "color"],
  [/^series composition\b|\bscript\b|\bscreenplay\b|\bscenario\b|\bwriter\b/, "script"],
  [/\bmusic\b|\bsongs?\b|\blyrics?\b/, "music"],
  [/\badr\b|\bsound\b|\brecording\b|\bfoley\b|\bdubbing\b|\bmixing\b/, "sound"],
  [/title logo|advertis|publicity|promotion|\bsales\b|marketing|licens|distribution|public relations|\bweb\b|merchandis/, "other"],
  [/key animation|in-?between|\b2nd key\b|second key/, "keyAnimation"],
  [/animation director|animation supervisor|animation check|effects? animation|\banimators?\b|action director|\blayout\b/, "animation"],
  [/\bproduc(?:er|tion)s?\b|\bplanning\b|\bdesk\b|\bmanager\b|\bmanagement\b|\bcommittee\b|^animation$/, "production"],
  [/photography|\bcgi?\b|\b3d|\b2d works\b|\bvfx\b|special effects|\bcompositing\b|\bmodeling\b/, "photography"],
  [/\bedit(?:ing|or)\b/, "editing"],
  [/\bart\b|\bbackground|\billustration/, "art"],
  [/storyboard|\bdirector\b|\bdirection\b/, "direction"],
  [/\bdesign(?:er|s)?\b/, "design"],
];

/** The department a credit belongs to. Anything no rule claims is 其他. */
export function departmentOf(role: string | null): DepartmentKey {
  const base = baseRole(role ?? "");
  if (!base) return "other";
  for (const [pattern, key] of RULES) {
    if (pattern.test(base)) return key;
  }
  return "other";
}

/** One person within one department, with every role they have there. */
export interface StaffPerson {
  /** Stable within a title: the AniList id, or the names for a row without one. */
  key: string;
  staffId: number | null;
  nameJa: string | null;
  nameEn: string | null;
  nameCn: string | null;
  imageUrl: string | null;
  /** AniList's role text, in credit order, each once. */
  roles: string[];
}

export interface StaffDepartment {
  key: DepartmentKey;
  people: StaffPerson[];
}

/**
 * A department this size or larger lists names only. Key animation on a long
 * series runs to hundreds, almost none with a portrait; a grid of initials is
 * worse than a cloud of names.
 */
export const NAMES_ONLY_FROM = 40;

/** How much of each department the 全部 view shows before 「展开全部」. */
export const PREVIEW_PEOPLE = 9;
export const PREVIEW_NAMES = 36;

export function isNamesOnly(department: StaffDepartment): boolean {
  return department.people.length >= NAMES_ONLY_FROM;
}

function personKey(credit: StaffCredit): string {
  if (credit.staffId != null) return `id:${credit.staffId}`;
  return `name:${credit.nameJa ?? ""}\u0000${credit.nameEn ?? ""}`;
}

/**
 * Group a title's credits into departments, in DEPARTMENTS order; a
 * department nobody is in is left out. Within one, people keep the order of
 * their first credit there — AniList's order — and carry all their roles in
 * that department. A person with roles in two departments is in both.
 */
export function groupStaff(credits: readonly StaffCredit[]): StaffDepartment[] {
  const byDept = new Map<DepartmentKey, Map<string, StaffPerson>>();
  for (const credit of credits) {
    const dept = departmentOf(credit.role);
    const people = byDept.get(dept) ?? new Map<string, StaffPerson>();
    byDept.set(dept, people);
    const key = personKey(credit);
    const role = credit.role?.trim() ?? "";
    const known = people.get(key);
    if (known) {
      if (role && !known.roles.includes(role)) {
        people.set(key, { ...known, roles: [...known.roles, role] });
      }
      continue;
    }
    people.set(key, {
      key,
      staffId: credit.staffId,
      nameJa: credit.nameJa,
      nameEn: credit.nameEn,
      nameCn: credit.nameCn,
      imageUrl: credit.imageUrl,
      roles: role ? [role] : [],
    });
  }
  return DEPARTMENTS.filter((key) => byDept.has(key)).map((key) => ({
    key,
    people: [...byDept.get(key)!.values()],
  }));
}

/** How many people the departments hold, counting each person once. */
export function staffPeopleCount(departments: readonly StaffDepartment[]): number {
  const keys = new Set<string>();
  for (const d of departments) for (const p of d.people) keys.add(p.key);
  return keys.size;
}

/**
 * The form names and the query are compared in: NFKC (half-width katakana and
 * full-width Latin to their usual forms), lower case, no spaces or middle
 * dots — the same folding the server's character search applies.
 */
export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s・·]/g, "");
}

function personMatches(person: StaffPerson, needle: string, lang: Lang): boolean {
  const haystack = [
    person.nameJa,
    person.nameEn,
    person.nameCn,
    ...person.roles,
    ...person.roles.map((r) => staffRoleLabel(r, lang)),
    ...person.roles.map((r) => normalizeStaffRole(r)),
  ];
  return haystack.some((value) => !!value && normalizeSearch(value).includes(needle));
}

/**
 * The departments, keeping only the people whose names or roles contain the
 * query. An empty query returns the input itself.
 */
export function searchStaff(
  departments: StaffDepartment[],
  query: string,
  lang: Lang,
): StaffDepartment[] {
  const needle = normalizeSearch(query);
  if (!needle) return departments;
  return departments
    .map((d) => ({ key: d.key, people: d.people.filter((p) => personMatches(p, needle, lang)) }))
    .filter((d) => d.people.length > 0);
}
