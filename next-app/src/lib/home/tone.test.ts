import { describe, expect, test } from "bun:test";
import { contrastRatio, hueFromHex, oklchDegToRgb, type Rgb } from "@/lib/oklch";
import {
  BRAND_FALLBACK_ACCENT,
  animeHue,
  cardToneVars,
  oklchCss,
  pageToneVars,
  toneLadder,
} from "./tone";

// The homepage paints every card, and the page ground itself, from the hue of
// one poster. Two things can go wrong silently and both are pinned here:
//
//   1. The brand-violet fallback (#8B5CF6) is what go-api stores when AniList
//      gave no usable cover colour. It is not the anime's colour, so it must
//      not be painted as if it were — a quarter of a grid turning violet reads
//      as "these are related" when they are not.
//   2. The ladder is only safe because lightness and chroma are fixed. The
//      proof below walks all 360 hues (plus the neutral no-hue case) against
//      every surface the homepage puts text on, the same way lib/oklch.test.ts
//      does for the detail page.

describe("animeHue", () => {
  test("the brand fallback is not a hue, in any case", () => {
    expect(animeHue(BRAND_FALLBACK_ACCENT)).toBeNull();
    expect(animeHue("#8B5CF6")).toBeNull();
    expect(animeHue(" #8b5cf6 ")).toBeNull();
  });

  test("missing or malformed accents are not a hue", () => {
    expect(animeHue(null)).toBeNull();
    expect(animeHue(undefined)).toBeNull();
    expect(animeHue("")).toBeNull();
    expect(animeHue("not-a-colour")).toBeNull();
  });

  test("a grey accent has no stable hue", () => {
    expect(animeHue("#808080")).toBeNull();
  });

  test("a real accent keeps its angle, rounded to a tenth of a degree", () => {
    const exact = hueFromHex("#09afd8");
    expect(exact).not.toBeNull();
    expect(animeHue("#09afd8")).toBe(Math.round((exact as number) * 10) / 10);
  });
});

describe("oklchCss", () => {
  test("writes a plain oklch() the browser parses", () => {
    expect(oklchCss(76, 0.085, 222.7)).toBe("oklch(76% 0.085 222.7)");
  });

  test("alpha is appended with a slash", () => {
    expect(oklchCss(13, 0.012, 10, 0.78)).toBe("oklch(13% 0.012 10 / 0.78)");
  });

  test("no hue means no chroma — neutral, never red", () => {
    // 0° is red. A poster with no usable colour rendered as oklch(76% .085 0)
    // would be a colour the artwork never had.
    expect(oklchCss(76, 0.085, null)).toBe("oklch(76% 0 0)");
  });
});

describe("toneLadder", () => {
  test("uses the DESIGN.md ladder exactly", () => {
    expect(toneLadder(145)).toEqual({
      text: "oklch(76% 0.085 145)",
      quiet: "oklch(68% 0.07 145)",
      line: "oklch(52% 0.07 145)",
      fill: "oklch(24% 0.045 145)",
      onSolid: "oklch(15% 0.03 145)",
    });
  });

  test("a null hue gives the neutral ladder", () => {
    const t = toneLadder(null);
    expect(t.text).toBe("oklch(76% 0 0)");
    expect(t.fill).toBe("oklch(24% 0 0)");
  });
});

describe("the CSS custom properties", () => {
  test("card vars carry the ladder under the names the stylesheets read", () => {
    const vars = cardToneVars(200);
    expect(vars["--tone"]).toBe("oklch(76% 0.085 200)");
    expect(vars["--tone-quiet"]).toBe("oklch(68% 0.07 200)");
    expect(vars["--tone-line"]).toBe("oklch(52% 0.07 200)");
    expect(vars["--tone-fill"]).toBe("oklch(24% 0.045 200)");
  });

  test("page vars add the tinted ground, surface and popover layers", () => {
    const vars = pageToneVars(30);
    expect(vars["--home-ground"]).toBe("oklch(13% 0.012 30)");
    expect(vars["--home-surface"]).toBe("oklch(18% 0.014 30)");
    expect(vars["--home-pop"]).toBe("oklch(20% 0.016 30)");
    expect(vars["--home-tone"]).toBe("oklch(76% 0.085 30)");
    expect(vars["--home-tone-line"]).toBe("oklch(52% 0.07 30)");
    expect(vars["--home-on-solid"]).toBe("oklch(15% 0.03 30)");
  });
});

// ── The contrast proof ──────────────────────────────────────────────────────

const HUES: Array<number | null> = [null, ...Array.from({ length: 360 }, (_, i) => i)];

function rgbOf(L: number, C: number, hue: number | null): Rgb {
  return oklchDegToRgb(L, hue === null ? 0 : C, hue === null ? 0 : hue);
}

/** `rgba(235,235,245,a)` composited over an opaque background. */
function over(bg: Rgb, alpha: number): Rgb {
  const mix = (fg: number, b: number) => Math.round(fg * alpha + b * (1 - alpha));
  return { r: mix(235, bg.r), g: mix(235, bg.g), b: mix(245, bg.b) };
}

/** Lowest ratio across every hue, with the hue that produced it. */
function worst(fn: (hue: number | null) => number): { ratio: number; hue: number | null } {
  let out = { ratio: Infinity, hue: null as number | null };
  for (const h of HUES) {
    const r = fn(h);
    if (r < out.ratio) out = { ratio: r, hue: h };
  }
  return out;
}

const AA = 4.5;

describe("every text/background pair the homepage paints clears 4.5:1 at every hue", () => {
  const surfaces = [
    ["ground (13%)", 13, 0.012],
    ["surface (18%)", 18, 0.014],
    ["popover (20%)", 20, 0.016],
  ] as const;

  for (const [name, L, C] of surfaces) {
    test(`tone text on the ${name}`, () => {
      const w = worst((h) => contrastRatio(rgbOf(76, 0.085, h), rgbOf(L, C, h)));
      expect(w.ratio).toBeGreaterThanOrEqual(AA);
    });

    test(`quiet tone text on the ${name}`, () => {
      const w = worst((h) => contrastRatio(rgbOf(68, 0.07, h), rgbOf(L, C, h)));
      expect(w.ratio).toBeGreaterThanOrEqual(AA);
    });

    test(`the quietest neutral copy (58% white) on the ${name}`, () => {
      const w = worst((h) => {
        const bg = rgbOf(L, C, h);
        return contrastRatio(over(bg, 0.58), bg);
      });
      expect(w.ratio).toBeGreaterThanOrEqual(AA);
    });
  }

  test("tone text on its own fill (score pill, genre pills)", () => {
    const w = worst((h) => contrastRatio(rgbOf(76, 0.085, h), rgbOf(24, 0.045, h)));
    expect(w.ratio).toBeGreaterThanOrEqual(AA);
  });

  test("dark text on the solid tone button", () => {
    const w = worst((h) => contrastRatio(rgbOf(15, 0.03, h), rgbOf(76, 0.085, h)));
    expect(w.ratio).toBeGreaterThanOrEqual(AA);
  });
});

/** A white veil (`rgba(255,255,255,a)`) laid over an opaque background. */
function veil(bg: Rgb, alpha: number): Rgb {
  const mix = (b: number) => Math.round(255 * alpha + b * (1 - alpha));
  return { r: mix(bg.r), g: mix(bg.g), b: mix(bg.b) };
}

describe("the schedule page's veiled surfaces keep the same guarantee", () => {
  // The schedule page reuses the ladder and the three ground layers, and adds
  // translucent white veils on top of them: every row sits on 3% white over
  // the ground (6.5% when hovered), the selected day tab on 8%, a hovered row
  // inside an aside box on 5% over the surface. A veil lightens the
  // background, which only ever LOWERS contrast with light text, so each one
  // is proven here rather than assumed from the layer under it.
  //
  // 58% white is the quietest neutral copy the page uses (notes, aired times,
  // unselected counts). 0.5 — the design board's value for an aired time —
  // falls to 4.46:1 on the lightest veil, which is why the page does not use it.
  const veils = [
    ["a row (3% over the ground)", 13, 0.012, 0.03],
    ["a hovered row (6.5% over the ground)", 13, 0.012, 0.065],
    ["the selected day tab (8% over the ground)", 13, 0.012, 0.08],
    ["a hovered aside row (5% over the surface)", 18, 0.014, 0.05],
  ] as const;

  for (const [name, L, C, alpha] of veils) {
    test(`tone text on ${name}`, () => {
      const w = worst((h) => contrastRatio(rgbOf(76, 0.085, h), veil(rgbOf(L, C, h), alpha)));
      expect(w.ratio).toBeGreaterThanOrEqual(AA);
    });

    test(`58% white on ${name}`, () => {
      const w = worst((h) => {
        const bg = veil(rgbOf(L, C, h), alpha);
        return contrastRatio(over(bg, 0.58), bg);
      });
      expect(w.ratio).toBeGreaterThanOrEqual(AA);
    });
  }
});
