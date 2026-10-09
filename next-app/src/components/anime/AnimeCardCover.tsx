// The poster half of AnimeCard: the cover, or a flat box of the same shape
// when there is none.
//
// A module of its own so that a test can server-render exactly what a card
// draws for its cover (AnimeCardCover.render.test.tsx). AnimeCard itself
// cannot be imported by any test: its quick-subscribe toggle pulls in
// react-hot-toast, which testImportHygiene.test.ts keeps out of every test's
// import graph. Keep this file free of that chain.

import type { CSSProperties } from "react";
import FadeImage from "@/components/ui/FadeImage";

const imgStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

export default function AnimeCardCover({
  src,
  title,
  priority,
}: {
  src: string | null;
  /** The card's title, which is also the image's alt text. */
  title: string;
  priority: boolean;
}) {
  return src ? (
    // alt is kept for image search, but hidden from the a11y tree: it
    // is verbatim the title rendered a few lines below, and without
    // this the link would announce the name twice. This is the one
    // genuine duplicate that dropping aria-label exposed.
    // 180x240, and both halves of that are deliberate.
    //
    // The RATIO is 3:4, matching the CSS box's `aspect-ratio: 3/4`. The
    // old 230x320 declared 0.719 against a 0.75 box; harmless while
    // these were plain <img> attributes (CSS won), load-bearing now that
    // next/image builds the intrinsic box from them.
    //
    // The MAGNITUDE is what next/image resolves the srcset from. With no
    // `sizes`, it emits exactly two candidates -- the first configured
    // size >= width, and the first >= width*2 -- as 1x/2x descriptors.
    // Measured on prod, a card renders 155x206 on desktop (8 columns of
    // a 1400px container) and 163x217 on mobile (2 columns of 375).
    // width=180 therefore resolves to 256w and 384w, and 384 is just
    // above the 326 a DPR-2 phone actually needs. width=240 would have
    // resolved the 2x slot to 640w, since the ladder has nothing between
    // 384 and 640 -- 2.4x more pixels than the box can show.
    //
    // No `sizes` on purpose. Supplying it switches Next to emitting the
    // FULL candidate list, ~2 KB of srcset per image. The homepage
    // renders 207 covers, so that is ~400 KB of extra HTML on a page
    // whose stated budget is 180 KB total.
    <FadeImage
      src={src}
      alt={title}
      aria-hidden
      width={180}
      height={240}
      priority={priority}
      style={imgStyle}
    />
  ) : (
    <div style={{ ...imgStyle, background: "#2c2c2e" }} aria-hidden />
  );
}
