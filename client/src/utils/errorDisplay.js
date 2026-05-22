// errorDisplay.js — single place that maps a backend error envelope to a
// user-facing string under i18n. Backend (Go) emits English; zh.js's `errors`
// block translates to 中文 by English-key lookup; defaultValue passes through
// for en users (and any English string the zh dict doesn't yet cover).
//
// Why a helper: 8+ catch handlers across the app need the same logic. Inlining
// the 3-line pattern leads to copy-paste drift when the envelope shape evolves.

/**
 * Resolve a user-facing error string from an axios error.
 *
 * Behaviour:
 *  - If backend supplied `error.message`, look it up in the locale's `errors`
 *    namespace; missing keys fall through to the English string itself.
 *  - Otherwise (network failure, no response, malformed envelope) use the
 *    caller-supplied fallback i18n key.
 *
 * @param {Function} t - useLang().t — supports t(key, { defaultValue })
 * @param {unknown}  err - axios error (or anything; we read it defensively)
 * @param {string}   fallbackKey - i18n key used when backend didn't supply a message
 * @returns {string} A localized, displayable error string.
 */
export function errorDisplay(t, err, fallbackKey) {
  const backendMsg = err?.response?.data?.error?.message
  if (backendMsg) {
    return t(`errors.${backendMsg}`, { defaultValue: backendMsg })
  }
  return t(fallbackKey)
}
