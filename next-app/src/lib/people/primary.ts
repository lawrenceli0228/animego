// Which title a person or character page hangs under.
//
// The pages are reached from a title's cast and staff lists, and their
// breadcrumb names a title to go back to — but a page is one URL for every
// title the person or character is on, served from the ISR cache to everyone,
// so it cannot know which title a visitor came from (reading the referrer or a
// query would make the route dynamic). It names the title the page is most
// about instead: a character's biggest lead role, a person's first
// representative role, else their most popular credit. The same title gives
// the page its colour.

import type { Appearance, Character, PeopleWork, Person } from "./types";

const ROLE_RANK: Record<string, number> = { MAIN: 0, SUPPORTING: 1, BACKGROUND: 2 };

function rank(role: string | null): number {
  return role ? (ROLE_RANK[role.toUpperCase()] ?? 3) : 3;
}

function morePopular(a: PeopleWork, b: PeopleWork): number {
  return (b.popularity ?? -1) - (a.popularity ?? -1) || a.anilistId - b.anilistId;
}

/** The character's best role, in the most popular title it has it in. */
export function primaryAppearance(character: Pick<Character, "appearances">): Appearance | null {
  const sorted = [...character.appearances].sort(
    (a, b) => rank(a.role) - rank(b.role) || morePopular(a.anime, b.anime),
  );
  return sorted[0] ?? null;
}

/** Where a person page's breadcrumb leads, and which list there. */
export interface PersonAnchor {
  work: PeopleWork;
  list: "characters" | "staff";
}

export function personAnchor(
  person: Pick<Person, "representativeRoles" | "voiceRoles" | "staffRoles">,
): PersonAnchor | null {
  const rep = person.representativeRoles[0];
  if (rep) return { work: rep.anime, list: "characters" };
  const staffWorks = person.staffRoles.flatMap((y) => y.works.map((w) => w.anime));
  const top = [...staffWorks].sort(morePopular)[0];
  if (top) return { work: top, list: "staff" };
  const voiced = person.voiceRoles.flatMap((y) => y.roles.map((r) => r.anime))[0];
  return voiced ? { work: voiced, list: "characters" } : null;
}
