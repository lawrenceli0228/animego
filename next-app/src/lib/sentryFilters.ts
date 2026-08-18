// Which browser errors are ours, and which belong to somebody else's script.
//
// Separate from instrumentation-client.ts because that file calls
// Sentry.init() at module load, so importing it from a test would initialise
// the SDK. The patterns are the part worth testing anyway: a pattern that is
// slightly too broad does not fail loudly, it just quietly stops reporting a
// class of real bug, and nobody finds out until they go looking for an error
// that should have been there.
//
// Every entry below is justified by an issue actually seen in
// animego-org/javascript-nextjs. Nothing is added speculatively from a
// generic "common browser noise" list — an unused pattern is a blind spot
// with no upside.
//
// Matching semantics, verified against @sentry/core 10.54
// (integrations/eventFilters.js, utils/string.js): a string pattern is a
// SUBSTRING test, a RegExp is `.test()`, and both run against `event.message`,
// the last exception's `value`, and `"Type: value"`.

/**
 * Errors that cannot originate in this application.
 *
 * Sentry applies these in the EventFilters event processor, which runs before
 * `beforeSend` (client.js `_processEvent`: `_prepareEvent(...).then(prepared
 * => processBeforeSend(...))`). That ordering is load-bearing here — see the
 * Replay note in instrumentation-client.ts.
 */
export const IGNORED_ERROR_PATTERNS: Array<string | RegExp> = [
  // 88 events and climbing, all from in-app WebViews on Android in China.
  //
  //   Failed to execute 'querySelectorAll' on 'Document':
  //   'a[href*="http"][target="_blank"][rel="noopener"]:has(img)'
  //   is not a valid selector.
  //
  // Three things identify it as injected: the stack below Sentry's own
  // setInterval wrapper is all `<anonymous>` frames, the mechanism is
  // `auto.browser.browserapierrors.setInterval` (a polling loop), and the
  // browser is Chrome WebView 97 — `:has()` needs Chrome 105.
  //
  // Safe to drop as a whole class rather than by that one selector string:
  // the only querySelectorAll in this codebase is
  // `art.video.querySelectorAll("track")`, a literal that cannot be invalid.
  // If dynamic selectors ever get built here, narrow this entry first.
  "is not a valid selector",

  // Injected globals from host apps and extensions. Each names a symbol that
  // appears nowhere in this repository.
  "LIDNotifyId",
  "Can't find variable: _G",

  // A permission refusal surfaced as an error. Anchored rather than a bare
  // "not granted" substring, which would be broad enough to swallow a future
  // message of our own.
  /^(?:TypeError: )?not granted$/,
];

/**
 * Frames from these origins are never ours.
 *
 * Categorical rather than observational: an error whose stack comes from an
 * extension URL cannot be an application bug, so this can never hide one.
 * It does NOT catch the WebView case above — those frames are `<anonymous>`
 * and carry no URL at all, which is why the message patterns exist too.
 */
export const DENIED_URL_PATTERNS: RegExp[] = [
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /^safari-(?:web-)?extension:\/\//,
  /^webkit-masked-url:/,
];

/**
 * Sentry's matcher, reimplemented for the tests.
 *
 * Deliberately a copy rather than an import: the point of the suite is to
 * pin what these patterns do to the exact strings Sentry reported, and
 * borrowing the SDK's matcher would make the test agree with the SDK by
 * construction even if the SDK changed underneath us.
 */
export function matchesIgnored(message: string): boolean {
  return IGNORED_ERROR_PATTERNS.some((pattern) =>
    typeof pattern === "string" ? message.includes(pattern) : pattern.test(message),
  );
}
