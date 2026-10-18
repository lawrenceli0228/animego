// --- Intrinsic sizes for the images in the detail page's four sections ---
//
// (Related works and recommendations, characters and their voice actors,
// staff; page.tsx renders them.)
//
// These are next/image's srcset basis, NOT the CSS box: the layout lives in
// sections.module.css and the tiles are fluid. Next derives a 1x/2x pair from
// `width`, so the number has to be at least the widest the tile ever renders
// or every cover is upscaled on a retina screen — which is exactly what the
// old width={110} did to a 110px tile the moment anything grew it.
//
// They are also a contract with nginx: the 1x/2x widths Next derives from
// them are among the page shapes nginx keeps in its own cache zone and the
// nightly warm job encodes ahead of readers (the $next_image_zone map in
// nginx/default.p9.conf). imageVariantShapes.test.tsx renders these sizes
// and fails when one of them would ask for a width that list does not hold.

// Poster: 7:10, matching the hero cover. AniList's large covers are 460x650,
// so 7:10 crops almost nothing (page.module.css says the same thing about
// `.cover`). 160 is the widest a `.posterGrid` track gets — 192px at a 400px
// viewport, where the 2x candidate Next emits (384w) still covers it.
export const POSTER_SRC_W = 160;
export const POSTER_SRC_H = 229;
// Character / voice-actor portraits. Enlarged from 58x76 — see the note on
// `.people` in sections.module.css for why the grid track had to widen with
// them rather than after them.
export const PORTRAIT_W = 64;
export const PORTRAIT_H = 86;
// Staff avatar, up from 36. A 36px circle beside a name reads as a bullet.
export const STAFF_AVATAR = 44;
