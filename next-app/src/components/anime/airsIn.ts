// "3 天后" for the hero's next-episode strip. Its own module, with no
// imports, because NextAiringBadge is a client component: anything this
// pulls in ships to the browser, and the obvious home (detailFacts.ts, next
// door) reads the server dictionaries.

export interface AiringCopy {
  nextEpisode: string;
  airsInDays: string;
  airsInHours: string;
  airsInMinutes: string;
  airsSoon: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * "3 天后" / "in 3d" for an airing instant, or null once it has passed.
 *
 * Null rather than "已播出", because the value is only as fresh as the row:
 * AniList moves nextAiringEpisode forward the moment an episode airs and our
 * copy moves when the row is next read, up to a day later. A strip that
 * said "episode 1179 aired 5 hours ago" on a page whose row is a day old
 * would be stating the stale value as news; saying nothing is correct.
 *
 * The copy is a parameter — the dictionary's `{{n}}` templates — so this
 * stays a function of two numbers and some strings.
 */
export function airsIn(airingAtMs: number, nowMs: number, copy: AiringCopy): string | null {
  const delta = airingAtMs - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return null;
  if (delta >= DAY_MS) return withN(copy.airsInDays, Math.floor(delta / DAY_MS));
  if (delta >= HOUR_MS) return withN(copy.airsInHours, Math.floor(delta / HOUR_MS));
  if (delta >= MINUTE_MS) return withN(copy.airsInMinutes, Math.floor(delta / MINUTE_MS));
  return copy.airsSoon;
}

/** The one substitution the templates need; lib/i18n's `fill` does the same. */
function withN(template: string, n: number): string {
  return template.split("{{n}}").join(String(n));
}
