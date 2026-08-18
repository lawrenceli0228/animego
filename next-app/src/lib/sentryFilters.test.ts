import { describe, expect, test } from "bun:test";
import { eventFiltersIntegration } from "@sentry/core";
import { DENIED_URL_PATTERNS, IGNORED_ERROR_PATTERNS, matchesIgnored } from "./sentryFilters";

// The strings below are copied verbatim from animego-org/javascript-nextjs on
// 2026-08-18. That is the whole point of the file: a filter list is only
// trustworthy if it is pinned to the messages it was written against, and a
// pattern that stops matching after an SDK or extension update fails
// silently — the errors simply come back and nobody notices they left.
//
// The second half matters more than the first. Over-broad filtering is the
// real hazard here, because it removes a class of error from Sentry without
// removing it from production.

const SEEN_NOISE = {
  hasSelector:
    "Failed to execute 'querySelectorAll' on 'Document': 'a[href*=\"http\"][target=\"_blank\"][rel=\"noopener\"]:has(img)' is not a valid selector.",
  hasSelectorWithType:
    "SyntaxError: Failed to execute 'querySelectorAll' on 'Document': 'a[href*=\"http\"][target=\"_blank\"][rel=\"noopener\"]:has(img)' is not a valid selector.",
  lidNotify: "LIDNotifyId is not defined",
  lidNotifyWithType: "ReferenceError: LIDNotifyId is not defined",
  underscoreG: "Can't find variable: _G",
  notGranted: "not granted",
  notGrantedWithType: "TypeError: not granted",
};

describe("the noise we set out to silence", () => {
  for (const [name, message] of Object.entries(SEEN_NOISE)) {
    test(`drops ${name}`, () => {
      expect(matchesIgnored(message)).toBe(true);
    });
  }
});

describe("errors that must still reach Sentry", () => {
  // Sentry matches the bare `value` and `"Type: value"`, so both forms are
  // checked wherever the distinction could matter.
  const REAL = [
    // The three issues currently attributed to this application. If a filter
    // change ever swallows one of these, the suite says so.
    "Cannot read properties of null (reading 'removeChild')",
    "TypeError: Cannot read properties of null (reading 'removeChild')",
    "NoModificationAllowedError: An attempt was made to write to a file or directory which could not be modified due to the state of the underlying filesystem.",
    "Cannot read properties of undefined (reading 'call')",

    // Deliberately NOT filtered even though one instance looked like injected
    // script noise: a truncated or corrupted bundle produces exactly this, and
    // that is something worth being woken up for.
    "SyntaxError: Unexpected token '}'",

    // Same family as the /search removeChild — external DOM mutation showing
    // up inside React. Filtering it would hide a real React problem too.
    "Cannot set properties of undefined (setting '__reactFiber$xwuabbpxdh')",

    // Network and API failures.
    "TypeError: Failed to fetch",
    "TypeError: network error",
    "NotFoundError: A requested file or directory could not be found at the time an operation was processed.",
  ];

  for (const message of REAL) {
    test(`keeps: ${message.slice(0, 58)}`, () => {
      expect(matchesIgnored(message)).toBe(false);
    });
  }
});

describe("the patterns are no broader than they look", () => {
  test("'not granted' is anchored, not a substring", () => {
    // A bare substring would swallow anything that happened to contain the
    // phrase — including copy we might write ourselves.
    expect(matchesIgnored("Permission was not granted for the watch folder")).toBe(false);
    expect(matchesIgnored("not granted")).toBe(true);
  });

  test("the selector rule only covers invalid-selector errors", () => {
    expect(matchesIgnored("Failed to execute 'querySelectorAll' on 'Document'")).toBe(false);
    expect(matchesIgnored("track is not a valid selector")).toBe(true);
  });

  test("every pattern is a string or a RegExp", () => {
    // Sentry silently ignores anything else, which would look like a working
    // filter that does nothing.
    for (const pattern of IGNORED_ERROR_PATTERNS) {
      expect(typeof pattern === "string" || pattern instanceof RegExp).toBe(true);
    }
  });
});

describe("denyUrls", () => {
  test("matches extension origins", () => {
    const extensionUrls = [
      "chrome-extension://abcdefghijklmnop/content.js",
      "moz-extension://1234-5678/inject.js",
      "safari-extension://com.example.ext/script.js",
      "safari-web-extension://ABCD/script.js",
    ];
    for (const url of extensionUrls) {
      expect(DENIED_URL_PATTERNS.some((p) => p.test(url))).toBe(true);
    }
  });

  test("never matches our own bundles", () => {
    // Sentry resolves the last valid frame URL, which for our code is the
    // Next static chunk path.
    const ours = [
      "https://animegoclub.com/_next/static/chunks/4bd1b696-e356ca5ba0218e27.js",
      "app:///_next/static/chunks/9945-e65dabd9a75df177.js",
      "https://animegoclub.com/jassub/wasm/worker.bundle.js",
    ];
    for (const url of ours) {
      expect(DENIED_URL_PATTERNS.some((p) => p.test(url))).toBe(false);
    }
  });
});

// The checks above exercise a reimplementation of Sentry's matcher, on
// purpose. This one runs the patterns through the integration that actually
// ships, so the wiring is verified rather than assumed — the failure this
// guards against is an SDK change quietly making a pattern stop matching,
// which looks exactly like the noise coming back.
describe("through the real @sentry/core EventFilters integration", () => {
  const integration = eventFiltersIntegration({
    ignoreErrors: IGNORED_ERROR_PATTERNS,
    denyUrls: DENIED_URL_PATTERNS,
  });
  const client = { getOptions: () => ({}) } as never;

  const event = (type: string, value: string, filename?: string) => ({
    exception: {
      values: [
        { type, value, ...(filename ? { stacktrace: { frames: [{ filename }] } } : {}) },
      ],
    },
  });
  const dropped = (type: string, value: string, filename?: string) =>
    integration.processEvent?.(event(type, value, filename) as never, {} as never, client) === null;

  test("drops the injected-script noise", () => {
    expect(dropped("SyntaxError", SEEN_NOISE.hasSelector)).toBe(true);
    expect(dropped("ReferenceError", SEEN_NOISE.lidNotify)).toBe(true);
    expect(dropped("ReferenceError", SEEN_NOISE.underscoreG)).toBe(true);
    expect(dropped("TypeError", SEEN_NOISE.notGranted)).toBe(true);
  });

  test("keeps the errors attributed to this application", () => {
    expect(dropped("TypeError", "Cannot read properties of null (reading 'removeChild')")).toBe(false);
    expect(dropped("Error", "NoModificationAllowedError: An attempt was made to write to a file or directory which could not be modified due to the state of the underlying filesystem.")).toBe(false);
    expect(dropped("TypeError", "Cannot read properties of undefined (reading 'call')")).toBe(false);
    expect(dropped("SyntaxError", "Unexpected token '}'")).toBe(false);
  });

  test("denyUrls drops extension frames and spares ours", () => {
    expect(dropped("TypeError", "boom", "chrome-extension://abc/content.js")).toBe(true);
    expect(
      dropped("TypeError", "boom", "https://animegoclub.com/_next/static/chunks/4bd.js"),
    ).toBe(false);
  });
});
