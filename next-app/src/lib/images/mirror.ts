// AniList image URLs, pointed at our own mirror of the same files.
//
// In production, nginx keeps a cache of the AniList originals the site uses
// and serves them at /img/anilist/<path>, where <path> is the part of the
// AniList URL after /file/anilistcdn/. Rendering that URL instead of
// AniList's has two effects:
//
//  - the image optimizer (/_next/image) fetches the original from our own
//    domain, so a page keeps its images when AniList is slow, throttles us or
//    is down, for every original nginx already holds;
//  - a reader's browser asks for the optimized variant exactly as before. The
//    /_next/image URL changes, the bytes it serves do not.
//
// The switch is NEXT_PUBLIC_IMAGE_MIRROR_BASE, the mirror's URL prefix
// (https://animegoclub.com/img/anilist/ in production). Next inlines
// NEXT_PUBLIC_* at BUILD time, so it is a Docker build arg, not a runtime
// variable. Unset or empty, every URL is returned unchanged: local
// development and the CI e2e sandbox have no nginx in front of them, so they
// keep AniList's URLs.
//
// Only URLs nginx will actually serve are rewritten. MIRRORED_PATH is the same
// expression as nginx's location for /img/anilist/ (nginx/default.p9.conf);
// nginx answers 404 for any other path without contacting AniList, so
// rewriting a URL outside it would turn a working image into a missing one.
// Everything else comes back untouched: AniList paths of other kinds (user
// uploads live under the same prefix), a query string, YouTube stills, our own
// images, Bangumi portraits, null, "", strings that are not URLs.
//
// Called where images are rendered (FadeImage, and the few files that use
// next/image directly), and nowhere else. Structured data (JSON-LD) and
// share-card image URLs keep pointing at AniList on purpose.
// lib/images/nextImageCallSites.test.ts fails when a new next/image call site
// skips it.

const ANILIST_CDN_PREFIX = "https://s4.anilist.co/file/anilistcdn/";

/**
 * The image kinds the mirror serves, matched against the path after
 * /file/anilistcdn/. Case-sensitive, and character for character the same as
 * nginx's: keep the two identical.
 */
export const MIRRORED_PATH = new RegExp(
  String.raw`^(media/(anime|manga)/(cover/(large|medium|extraLarge|small)|banner)|character/(large|medium)|staff/(large|medium))/[A-Za-z0-9_.-]+\.(jpe?g|png|gif|webp)$`,
);

/**
 * The mirror URL for an AniList image when this build has a mirror and nginx
 * serves that kind of image; otherwise the input, unchanged. Never throws.
 *
 * Null in, null out, and likewise undefined: only a string can change, and it
 * stays a string.
 */
export function toMirrorUrl<T extends string | null | undefined>(url: T): T extends string ? string : T;
export function toMirrorUrl(url: string | null | undefined): string | null | undefined {
  // Read on every call rather than once at module load: Next replaces this
  // exact expression with the build-time value, and tests flip it per case.
  const base = process.env.NEXT_PUBLIC_IMAGE_MIRROR_BASE?.trim();
  if (!base || typeof url !== "string" || !url.startsWith(ANILIST_CDN_PREFIX)) return url;

  const path = url.slice(ANILIST_CDN_PREFIX.length);
  if (!MIRRORED_PATH.test(path)) return url;

  // A base set without its trailing slash would glue the path onto the last
  // segment ("/img/anilistmedia/...") and break every image on the site.
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${path}`;
}
