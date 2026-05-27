/**
 * Per-anime poster accent cache (Next.js port of client/src/utils/accentCache.js).
 *
 * Lets direct links / page refreshes skip the "neutral → reveal" halo-in delay
 * by remembering the last-seen accent in localStorage. SSR-safe: every
 * function returns null / no-ops when `window` is undefined, so callers can
 * call them unconditionally inside `'use client'` components without guarding.
 *
 * Public API:
 *   readAccent(anilistId)              → { accent, rgb, source } | null
 *   writeAccent(anilistId, accent, rgb, source?='server') → void
 *
 * `source` is 'server' when AniList provided the color and 'client' when we
 * fell back to canvas k-means. The brand-violet fallback (#8B5CF6) is never
 * cached — caching it would carry "I don't know the real color" forward.
 */
import type { AccentSource, CachedAccent } from "./accentTypes";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_ACCENT = "#8B5CF6";
const key = (id: number): string => `acc:${id}`;

interface StoredAccent {
  accent: unknown;
  rgb: unknown;
  t: unknown;
  source?: unknown;
}

export function readAccent(id: number | null | undefined): CachedAccent | null {
  if (!id || typeof window === "undefined" || typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAccent;
    const accent = typeof parsed.accent === "string" ? parsed.accent : null;
    const rgb = typeof parsed.rgb === "string" ? parsed.rgb : null;
    const t = typeof parsed.t === "number" ? parsed.t : null;
    if (!accent || !rgb || t === null) return null;
    if (Date.now() - t > TTL_MS) {
      localStorage.removeItem(key(id));
      return null;
    }
    const source: AccentSource = parsed.source === "client" ? "client" : "server";
    return { accent, rgb, source };
  } catch {
    return null;
  }
}

export function writeAccent(
  id: number | null | undefined,
  accent: string,
  rgb: string,
  source: AccentSource = "server",
): void {
  if (!id || !accent || !rgb || typeof window === "undefined" || typeof localStorage === "undefined") {
    return;
  }
  // Skip the brand-violet fallback — caching it would carry the "I don't know
  // the real color" state forward into future sessions.
  if (accent.toLowerCase() === FALLBACK_ACCENT.toLowerCase()) return;
  try {
    localStorage.setItem(
      key(id),
      JSON.stringify({ accent, rgb, t: Date.now(), source }),
    );
  } catch {
    /* quota / private mode — silently skip */
  }
}
