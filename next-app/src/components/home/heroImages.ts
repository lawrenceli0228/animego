// The <img> props for the homepage hero's covers and banners.
//
// Same image conventions as the rest of the site (see FadeImage): AniList
// URLs pointed at our mirror when the build has one (toMirrorUrl), through the
// optimizer, quality 85 (AVIF q65). Covers at their rendered size; banners at
// their native 1900px, because object-fit: cover scales a 4.75:1 banner to
// ~2300px wide in a 484px-tall hero — anything smaller is upscaled.
//
// A module of its own so that a test can check what the hero asks the
// optimizer for (heroImages.test.ts). HomeHero itself cannot be imported by
// any test: its follow button pulls in react-hot-toast, which
// testImportHygiene.test.ts keeps out of every test's import graph.

import { getImageProps } from "next/image";
import { toMirrorUrl } from "@/lib/images/mirror";

export function heroCoverProps(src: string) {
  return getImageProps({ src: toMirrorUrl(src), alt: "", width: 196, height: 276, quality: 85 }).props;
}

/**
 * The wide image behind a slide: its banner, or its cover stretched into that
 * place when the title has no banner (`isBanner` false).
 */
export function heroBannerProps(src: string, isBanner: boolean) {
  const mirrored = toMirrorUrl(src);
  return isBanner
    ? getImageProps({ src: mirrored, alt: "", width: 1900, height: 400, quality: 85 }).props
    : getImageProps({ src: mirrored, alt: "", width: 460, height: 650, quality: 85 }).props;
}
