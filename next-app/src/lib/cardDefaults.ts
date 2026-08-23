// Default member-pass art for users who haven't personalised their pass.
// Served from public/card_default/. The card face falls back to the square
// image; the cinematic backdrop / mini-card fall back to the wide one.
export const DEFAULT_CARD_IMAGE = "/card_default/card.jpg";
export const DEFAULT_BACKDROP_IMAGE = "/card_default/backdrop.jpg";

// The same artwork at 96x96, for the small round avatars in comment threads,
// watcher rows and notification items.
//
// Those all render at 24x24 -- measured, eight of them on /anime/[id] -- and
// they were being served DEFAULT_CARD_IMAGE, which exists at the size the
// member-pass FACE needs (252x352 at DPR2). That is 41.7 KB to paint 576
// pixels, on the page Google indexes. 96 covers 24 to DPR4 and costs 2.8 KB.
//
// It cannot be solved by next/image the way covers were: these render through
// FallbackImg, which has to stay a plain <img> because its real src is
// /api/avatars/*, served by go-api from its own volume. Next resolves a
// same-origin path through an internal request handled inside the next-app
// process, which has no /api route in production -- it would 404 into
// FallbackImg's own onError and silently show this default instead.
export const DEFAULT_AVATAR_IMAGE = "/card_default/avatar.jpg";
