// The two page reads, shared by each route's generateMetadata and page so
// Next memoises one fetch per render.
//
// auth:false — the pages are public and ISR-cached for everyone, so the
// fetch must not read cookies or headers (that would make the route dynamic,
// or cache one visitor's render for all). revalidate matches the page's.
//
// null is "no such page" (the API's 404: an id no non-adult title credits);
// anything else that goes wrong is thrown, for the route's error boundary —
// a transient failure must not be cached as a 404.

import { apiGet, ApiError } from "@/lib/api";
import type { Character, Person } from "./types";

/** Keep in step with `export const revalidate` in the two route files. */
export const PEOPLE_REVALIDATE_SECONDS = 60;

async function loadOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiGet<T>(path, { revalidate: PEOPLE_REVALIDATE_SECONDS, auth: false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function loadPerson(id: number): Promise<Person | null> {
  return loadOrNull<Person>(`/api/people/${id}`);
}

export function loadCharacter(id: number): Promise<Character | null> {
  return loadOrNull<Character>(`/api/characters/${id}`);
}

/**
 * The page as it is right now, for its edit state: never cached, since the
 * draft is diffed against it and an accepted edit must show at once. Still
 * anonymous -- the answer is the same for everyone.
 */
async function loadFreshOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiGet<T>(path, { cache: "no-store", auth: false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function loadPersonFresh(id: number): Promise<Person | null> {
  return loadFreshOrNull<Person>(`/api/people/${id}`);
}

export function loadCharacterFresh(id: number): Promise<Character | null> {
  return loadFreshOrNull<Character>(`/api/characters/${id}`);
}
