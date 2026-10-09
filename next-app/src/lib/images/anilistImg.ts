// AniList images shown by a plain <img> or a CSS background, sent through the
// image optimizer with our mirror as the source.
//
// FadeImage and the direct next/image call sites already do this for what they
// render (lib/images/mirror.ts). These surfaces cannot use them:
//  - CSS backgrounds;
//  - <img> elements that swap to a fallback on error (FallbackImg, the member
//    pass, community avatars);
//  - a few small thumbnails.
// So the browser fetched those AniList URLs itself, straight from AniList's
// CDN, full size: profile backdrops, member-pass art, and the avatar a member
// without a photo shows (the cover of the anime they picked), in the navbar on
// every page. These helpers give each surface the address FadeImage would:
// /_next/image, with the mirror as the source when the build has one (AniList
// itself when not), at a width the optimizer serves, quality 85.
//
// Only an AniList image of a kind the mirror serves is changed. Anything else
// comes back exactly as given:
//  - a member's own photo under /api/avatars;
//  - a blob: preview;
//  - a Bangumi or dandanplay image;
//  - the site's default art.
// Those must not go through the optimizer: FadeImage says what that costs.
//
// lib/images/plainImageCallSites.test.ts fails when a file renders a plain
// <img> or builds a CSS url() without going through here, unless it is listed
// with the reason it never shows an AniList image.

import { getImageProps } from "next/image";
import { isMirrorableAniListUrl, toMirrorUrl } from "./mirror";

/** The one quality next.config.ts allows (images.qualities). */
const QUALITY = 85;

/** For a background as wide as the page: the largest width next.config.ts serves. */
export const FULL_WIDTH = 1920;

/**
 * src and srcSet for a plain <img> drawn at width x height CSS pixels: the 1x
 * and 2x variants, as next/image would emit them. An image that is not an
 * AniList one gets its own URL back and no srcSet.
 */
export function anilistImgProps(
  url: string,
  width: number,
  height: number,
): { src: string; srcSet?: string } {
  if (!isMirrorableAniListUrl(url)) return { src: url };
  const { src, srcSet } = getImageProps({
    src: toMirrorUrl(url),
    alt: "",
    width,
    height,
    quality: QUALITY,
  }).props;
  return { src, srcSet };
}

/**
 * One URL for an image drawn at width CSS pixels: the 2x variant, for a CSS
 * background or an <img> that must have a single src. An image that is not an
 * AniList one comes back as given.
 */
export function anilistImageSrc<T extends string | null | undefined>(url: T, width: number): T | string {
  if (!isMirrorableAniListUrl(url)) return url;
  return anilistImgProps(url, width, width).src;
}
