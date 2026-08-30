import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import HeroAccent from "./HeroAccent";

// The whole per-anime palette rests on one property that is easy to lose and
// invisible when you do: `--poster-hue` has to be in the SERVER-RENDERED HTML.
//
// /anime/[id] is an RSC behind ISR and a CF edge cache. If the hue were
// written on the client instead — moved into the existing useEffect, or
// derived after mount "to keep the server render simple" — the page would
// paint the fallback violet first and swap to the anime's colour on
// hydration. On a cached document that flash is the first thing a visitor
// sees, and nothing in the suite would go red: the component still renders,
// the colour still arrives, the screenshot taken after hydration still looks
// right.
//
// The component's own docstring used to assert the opposite of what the code
// does ("the wrapper renders neutral, no accent vars, on first paint"),
// which is exactly how this gets refactored away by someone reading it in
// good faith. So the invariant is pinned here rather than described.

const COVER = "https://example.invalid/cover.jpg";

/** Renders the wrapper the way Next's server pass does — no effects run. */
const ssr = (props: {
  posterAccent: string | null;
  posterAccentRgb: string | null;
}) =>
  renderToStaticMarkup(
    <HeroAccent anilistId={1} coverImageUrl={COVER} {...props}>
      <span>hero</span>
    </HeroAccent>,
  );

describe("HeroAccent server render", () => {
  test("inlines --poster-hue when the row has a real accent", () => {
    // #7caf62 is a green taken from a production row.
    const html = ssr({ posterAccent: "#7caf62", posterAccentRgb: "124, 175, 98" });
    expect(html).toContain("--poster-hue:");
    // The angle of that specific green, not just "some number is present".
    // 135.8° sits in the green arc (pure #00ff00 is 142.5°), and it is the
    // measured value — an earlier draft of this line guessed 14x and failed,
    // which is the reason it asserts a value at all.
    expect(html).toContain("--poster-hue:135.8");
  });

  test("inlines the raw accent pair alongside it", () => {
    const html = ssr({ posterAccent: "#7caf62", posterAccentRgb: "124, 175, 98" });
    expect(html).toContain("--poster-accent:#7caf62");
    expect(html).toContain("--poster-accent-rgb:124, 175, 98");
  });

  test("emits no hue at all for the brand-violet fallback", () => {
    // #8b5cf6 means "we never found a colour". Publishing a hue for it would
    // dress every unsampled anime in the same violet and call it identity.
    const html = ssr({ posterAccent: "#8b5cf6", posterAccentRgb: "139, 92, 246" });
    expect(html).not.toContain("--poster-hue");
    expect(html).not.toContain("--poster-accent:");
  });

  test("emits no hue for a greyscale accent rather than defaulting to red", () => {
    // A hue angle from a near-achromatic colour is rounding noise, and 0° is
    // red — the one wrong answer that looks like a deliberate choice.
    const html = ssr({ posterAccent: "#808080", posterAccentRgb: "128, 128, 128" });
    expect(html).not.toContain("--poster-hue");
    // The raw pair still ships; only the derived angle is withheld.
    expect(html).toContain("--poster-accent:#808080");
  });

  test("renders children and stays neutral when there is no accent", () => {
    const html = ssr({ posterAccent: null, posterAccentRgb: null });
    expect(html).toContain("hero");
    expect(html).not.toContain("--poster-hue");
    expect(html).toContain('data-accent-ready="false"');
  });

  test("carries the poster-scope class that rebuilds the ramp", () => {
    // The class and the inline hue are one mechanism, not two things that
    // happen to be on the same element. globals.css re-declares
    // --poster-tone* under .poster-scope because a custom property resolves
    // its var()s on the element that declares it — the :root copies are
    // already-finished violet by the time they inherit. Drop the class and
    // every anime silently shares one colour; drop the hue and the class has
    // nothing to build from. Neither failure shows up in markup review.
    for (const accent of [
      { posterAccent: "#7caf62", posterAccentRgb: "124, 175, 98" },
      { posterAccent: null, posterAccentRgb: null },
    ]) {
      expect(ssr(accent)).toContain('class="poster-scope"');
    }
  });

  test("the halo is still un-fired on the server, accent or not", () => {
    // data-accent-ready gates the box-shadow transition. It must start false
    // so the halo animates in — this is the part that IS neutral on first
    // paint, and the part the old docstring was actually describing.
    const html = ssr({ posterAccent: "#7caf62", posterAccentRgb: "124, 175, 98" });
    expect(html).toContain('data-accent-ready="false"');
    expect(html).toContain('data-accent-fast="true"');
  });
});
