// The URLs of the person and character pages and of what they link to. One
// module, so the cards, the breadcrumbs, the JSON-LD and the sitemap cannot
// spell a path two ways.

export function personPath(id: number): string {
  return `/person/${id}`;
}

export function characterPath(id: number): string {
  return `/character/${id}`;
}

export function animePath(id: number): string {
  return `/anime/${id}`;
}

/**
 * A title's full cast and staff lists, the tabs the breadcrumb's middle link
 * leads back to (the title's characters for a voice, its staff for a credit).
 */
export function animeListPath(id: number, list: "characters" | "staff"): string {
  return `/anime/${id}/${list}`;
}

/**
 * The id in a /person/[id] or /character/[id] URL, or null.
 *
 * Canonical digits only: "007" and "7" would otherwise be two URLs of one
 * page, and a page must have one. The bound is the API's (an int32).
 */
export function parseEntityId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2_147_483_647 ? id : null;
}
