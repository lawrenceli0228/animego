// The remote sources the image optimizer (/_next/image) will fetch, and the
// check that tells a caller whether a given src is one of them.
//
// One list, two readers:
//
//  - next.config.ts hands it to Next as `images.remotePatterns`. That is what
//    next/image validates a src against, and what the optimizer enforces: a
//    source outside it answers 400.
//  - FadeImage asks canOptimize() before handing a src to next/image, and
//    renders a plain <img> for anything the optimizer would refuse.
//
// The two have to agree exactly, and the cost of disagreeing is lopsided. If
// canOptimize says yes to a src the list does not cover, next/image THROWS
// while rendering under `next dev` (which is what the e2e sandbox runs), so a
// server-rendered page answers 500; in a production build the same src comes
// back from the optimizer as a 400 and the image is blank. If it says no to a
// src the list does cover, the image is merely served unoptimized. So the
// matcher below errs towards "no": a pattern it cannot evaluate exactly
// matches nothing.
//
// This file must stay importable by next.config.ts, which Next loads with a
// compiler of its own, outside the app's bundler and its path aliases:
// relative imports only (no `@/` alias), nothing from React, nothing from
// Next.

/**
 * One entry of `images.remotePatterns`, narrowed to the shape canOptimize can
 * evaluate exactly: one literal host, one literal path prefix followed by
 * `/**`, and no query string.
 */
export interface OptimizerRemotePattern {
  protocol: "https";
  hostname: string;
  pathname: `/${string}/**`;
  /**
   * Always "". Omitting `search` would imply `**`, letting a crafted query
   * turn the optimizer into a proxy for arbitrary upstream responses.
   */
  search: "";
}

export const IMAGE_REMOTE_PATTERNS: readonly OptimizerRemotePattern[] = [
  {
    // AniList's media CDN. Covers, banners, character and staff portraits all
    // live under /file/anilistcdn/.
    protocol: "https",
    hostname: "s4.anilist.co",
    pathname: "/file/anilistcdn/**",
    search: "",
  },
  {
    // Our own copy of those AniList originals, served by nginx from its cache
    // (see lib/images/mirror.ts for which URLs are rewritten to it). It is on
    // the public domain rather than the internal docker network on purpose:
    // the optimizer refuses any source that resolves to a private address
    // unless `dangerouslyAllowLocalIP` is set, and that stays off.
    //
    // Listed unconditionally, whether or not this build rewrites to the
    // mirror, so a build with the switch on can never render a src that the
    // allowlist refuses.
    protocol: "https",
    hostname: "animegoclub.com",
    pathname: "/img/anilist/**",
    search: "",
  },
  {
    // Detail-page trailer stills. The video itself is not requested until the
    // visitor presses play; this image keeps the hero preview light.
    protocol: "https",
    hostname: "i.ytimg.com",
    pathname: "/vi/**",
    search: "",
  },
];

const GLOBSTAR_SUFFIX = "/**";

/** Anything picomatch would read as glob syntax rather than as a literal. */
const GLOB_SYNTAX = /[*?[\]{}()!+@\\]/;

/**
 * Next's own check (next/dist/shared/lib/match-remote-pattern) compiles each
 * pattern with picomatch. Calling it from here would put picomatch in every
 * page's client bundle, since FadeImage is a client component, so this
 * evaluates the one glob shape the list uses instead: a literal prefix
 * followed by `/**`.
 *
 * For that shape the two agree on every URL the WHATWG parser can produce.
 * picomatch's `prefix/**` matches the bare prefix, and the prefix followed by
 * `/` and anything at all, except paths with `.` or `..` segments, which a
 * parsed URL never has (the parser resolves them). An unspecified `port`
 * means any port in both. remotePatterns.test.ts runs both over the same URLs.
 */
function matchesPattern(pattern: OptimizerRemotePattern, url: URL): boolean {
  if (!pattern.pathname.endsWith(GLOBSTAR_SUFFIX)) return false;
  const prefix = pattern.pathname.slice(0, -GLOBSTAR_SUFFIX.length);
  if (GLOB_SYNTAX.test(pattern.hostname) || GLOB_SYNTAX.test(prefix)) return false;

  return (
    url.protocol === `${pattern.protocol}:` &&
    url.hostname === pattern.hostname &&
    url.search === pattern.search &&
    (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  );
}

/**
 * Whether next/image will accept this src for optimization, with the config
 * in next.config.ts. False means "render it unoptimized", which never throws.
 *
 * A path on this site ("/...") is accepted, with two exceptions that Next
 * refuses: a protocol-relative "//host/..." (next/image throws on it in
 * development), and a query string, which Next 16's default
 * `images.localPatterns` rejects in every environment, production included.
 * Anything else must parse as an absolute URL and match a remote pattern.
 * A string that does not parse is not optimizable: the alternative is letting
 * next/image decide, and on a server-rendered route its way of deciding is to
 * throw.
 */
export function canOptimize(src: string): boolean {
  if (src.startsWith("/")) return !src.startsWith("//") && !src.includes("?");

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  return IMAGE_REMOTE_PATTERNS.some((pattern) => matchesPattern(pattern, url));
}
