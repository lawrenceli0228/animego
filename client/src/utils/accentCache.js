/**
 * Per-anime poster accent cache.
 *
 * Lets direct links / page refreshes skip the "neutral → reveal" halo-in delay
 * by remembering the last-seen accent. If reading/writing fails (private mode,
 * storage full, SSR) the caller transparently falls back to the reveal path.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const FALLBACK_ACCENT = '#8B5CF6'
const key = (id) => `acc:${id}`

export function readAccent(id) {
  if (!id || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key(id))
    if (!raw) return null
    const { accent, rgb, t } = JSON.parse(raw)
    if (!accent || !rgb || typeof t !== 'number') return null
    if (Date.now() - t > TTL_MS) {
      localStorage.removeItem(key(id))
      return null
    }
    return { accent, rgb }
  } catch {
    return null
  }
}

export function writeAccent(id, accent, rgb) {
  if (!id || !accent || !rgb || typeof localStorage === 'undefined') return
  // Skip the brand-violet fallback — caching it would carry the "I don't know
  // the real color" state forward into future sessions.
  if (accent.toLowerCase() === FALLBACK_ACCENT.toLowerCase()) return
  try {
    localStorage.setItem(key(id), JSON.stringify({ accent, rgb, t: Date.now() }))
  } catch {
    /* quota / private mode — silently skip */
  }
}
