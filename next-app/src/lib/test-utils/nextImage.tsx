// Rendering next/image in a test the way `next dev` renders it.
//
// A plain renderToStaticMarkup under bun differs from `next dev` in two ways,
// and each one alone would hide the failure the image tests exist to catch (a
// src next/image refuses, which under `next dev` THROWS while the page
// renders on the server, see components/ui/FadeImage.tsx):
//
//  - bun runs tests with NODE_ENV=test, and next/image skips its
//    remotePatterns check under "test" as it does under "production". Only
//    "development" checks.
//  - next/image reads its config from a value the build inlines
//    (process.env.__NEXT_IMAGE_OPTS) or from ImageConfigContext. A test has
//    neither, so it falls back to Next's defaults, whose remotePatterns is
//    empty.
//
// renderAsNextDev() closes both gaps: the app's own remotePatterns (the list
// next.config.ts hands to Next) through ImageConfigContext, and
// NODE_ENV=development for exactly as long as the synchronous render takes.
//
// bun runs every test file in one process, so anything set on process.env
// here is restored before the call returns, whether or not it threw. A
// leaked NODE_ENV would switch other files' renders into development checks;
// a leaked mirror switch would rewrite their images.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageConfigContext } from "next/dist/shared/lib/image-config-context.shared-runtime";
import { imageConfigDefault, type ImageConfigComplete } from "next/dist/shared/lib/image-config";
import { IMAGE_REMOTE_PATTERNS } from "@/lib/images/remotePatterns";

/** What production builds set NEXT_PUBLIC_IMAGE_MIRROR_BASE to. */
export const PRODUCTION_MIRROR_BASE = "https://animegoclub.com/img/anilist/";

const ANILIST_CDN_PREFIX = "https://s4.anilist.co/file/anilistcdn/";

/** The mirror URL for an AniList CDN URL, written out independently of toMirrorUrl. */
export function mirrorOf(anilistUrl: string): string {
  if (!anilistUrl.startsWith(ANILIST_CDN_PREFIX)) throw new Error(`not an AniList CDN URL: ${anilistUrl}`);
  return PRODUCTION_MIRROR_BASE + anilistUrl.slice(ANILIST_CDN_PREFIX.length);
}

type Env = Record<string, string | undefined>;

/** Runs fn with these variables set (undefined = unset), restoring them afterwards. */
export function withEnv<T>(vars: Env, fn: () => T): T {
  const env = process.env as Env;
  const saved: Env = Object.fromEntries(Object.keys(vars).map((name) => [name, env[name]]));
  const apply = (values: Env) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/** Runs fn with the AniList mirror switched on at `base`, or off when undefined. */
export function withMirror<T>(base: string | undefined, fn: () => T): T {
  return withEnv({ NEXT_PUBLIC_IMAGE_MIRROR_BASE: base }, fn);
}

/**
 * The image config the app runs with, as far as next/image's render-time
 * checks read it. remotePatterns is the app's own list. localPatterns is what
 * Next 16 fills in when next.config.ts leaves it out. qualities only keeps
 * FadeImage's quality 85 from logging a warning on every render.
 */
export const APP_IMAGE_CONFIG: ImageConfigComplete = {
  ...imageConfigDefault,
  remotePatterns: [...IMAGE_REMOTE_PATTERNS],
  localPatterns: [{ pathname: "**", search: "" }],
  qualities: [85],
};

/** renderToStaticMarkup, with next/image validating every src as `next dev` does. */
export function renderAsNextDev(ui: ReactElement, config: ImageConfigComplete = APP_IMAGE_CONFIG): string {
  return withEnv({ NODE_ENV: "development" }, () =>
    renderToStaticMarkup(<ImageConfigContext.Provider value={config}>{ui}</ImageConfigContext.Provider>),
  );
}

const decodeAttribute = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The src of every <img> in some markup, in document order, entities decoded. */
export function imgSrcs(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/g)].map((m) => decodeAttribute(m[1]));
}

/** The start of the src next/image emits for a src it sends through the optimizer. */
export function optimizedFrom(src: string): string {
  return `/_next/image?url=${encodeURIComponent(src)}&`;
}
