import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  GREY_CHROMA_FLOOR,
  hueFromHex,
  oklchDegToRgb,
  oklchToHex,
  parseHex,
  rgbToOklch,
} from "./oklch";

// This maths shipped to production untested. Its own header used to claim
// "parity tests on the legacy side already pin this math" — the legacy
// `client/` directory it pointed at is no longer in the repository, so those
// tests have not run for as long as it has been gone. Extracting the module
// out of sampleCoverAccent.ts (whose only entry point needs a canvas, and so
// cannot be unit-tested at all) is what makes these assertions possible.

const hex = (s: string) => {
  const p = parseHex(s);
  if (!p) throw new Error(`bad hex in test: ${s}`);
  return { r: p.r, g: p.g, b: p.b };
};

describe("the OKLab matrices", () => {
  // Reference values from Björn Ottosson's own worked examples.
  // https://bottosson.github.io/posts/oklab/ — sRGB white, and the primaries.
  test("white is L=1, C=0", () => {
    const { L, C } = rgbToOklch({ r: 255, g: 255, b: 255 });
    expect(L).toBeCloseTo(1, 3);
    expect(C).toBeCloseTo(0, 3);
  });

  test("black is L=0", () => {
    expect(rgbToOklch({ r: 0, g: 0, b: 0 }).L).toBeCloseTo(0, 3);
  });

  test("mid grey is achromatic", () => {
    expect(rgbToOklch({ r: 128, g: 128, b: 128 }).C).toBeCloseTo(0, 3);
  });

  test("round-trips a saturated colour through OKLCH back to the same hex", () => {
    // The property that actually matters for the sampler: converting to OKLCH
    // and back must not drift the colour. A transposed matrix coefficient
    // survives every single-direction assertion above but fails here.
    for (const start of ["#7caf62", "#e45d35", "#2e6fbf", "#c2185b", "#d4a017"]) {
      expect(oklchToHex(rgbToOklch(hex(start))).hex).toBe(start);
    }
  });

  test("the degrees and radians entry points agree", () => {
    // oklchDegToRgb is what the test below reasons with; rgbToOklch is what
    // ships. If they disagree the proof would be about a different colour
    // space than the one the browser paints.
    for (const start of ["#7caf62", "#c2185b", "#2e6fbf"]) {
      const { L, C } = rgbToOklch(hex(start));
      const deg = hueFromHex(start);
      expect(deg).not.toBeNull();
      const back = oklchDegToRgb(L * 100, C, deg!);
      expect(back).toEqual(hex(start));
    }
  });
});

describe("hueFromHex", () => {
  test("rejects malformed input rather than defaulting to 0°", () => {
    // 0° is red. Silently returning it for junk input would paint a red
    // palette on an anime whose accent failed to parse.
    for (const bad of [null, undefined, "", "#fff", "rgb(1,2,3)", "#gggggg", "12345678"]) {
      expect(hueFromHex(bad)).toBeNull();
    }
  });

  test("accepts with or without the leading #, any case", () => {
    expect(hueFromHex("7CAF62")).toBeCloseTo(hueFromHex("#7caf62")!, 6);
  });

  test("returns null for greys, whose hue angle is rounding noise", () => {
    for (const grey of ["#000000", "#808080", "#ffffff", "#1c1c1e", "#2c2c2e"]) {
      expect(hueFromHex(grey)).toBeNull();
    }
  });

  test("the grey floor is where it says it is", () => {
    // Guards the guard: if GREY_CHROMA_FLOOR were raised until it swallowed
    // real cover colours, every anime would lose its hue and the feature
    // would silently degrade to the fallback with nothing going red.
    for (const real of ["#7caf62", "#e45d35", "#2e6fbf", "#c2185b", "#d4a017"]) {
      expect(rgbToOklch(hex(real)).C).toBeGreaterThan(GREY_CHROMA_FLOOR);
      expect(hueFromHex(real)).not.toBeNull();
    }
  });

  test("is normalised to 0–360, never negative", () => {
    // atan2 returns −π…π. Blues and purples land in the negative half, and a
    // raw radian-to-degree conversion would emit e.g. −96°, which CSS
    // `oklch()` accepts but which breaks any arithmetic a caller does on it.
    for (const b of ["#2e6fbf", "#8b5cf6", "#c2185b", "#0a84ff"]) {
      const h = hueFromHex(b);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(0);
      expect(h!).toBeLessThan(360);
    }
  });

  test("puts known colours in the right part of the wheel", () => {
    expect(hueFromHex("#ff0000")!).toBeCloseTo(29.2, 0);
    expect(hueFromHex("#00ff00")!).toBeCloseTo(142.5, 0);
    expect(hueFromHex("#0000ff")!).toBeCloseTo(264.1, 0);
  });

  test("the --poster-hue fallback in globals.css is the brand violet's angle", () => {
    // globals.css seeds `--poster-hue: 292.7` and its comment claims that is
    // #8b5cf6's own hue, so a poster with no usable accent falls back to the
    // placeholder's colour family rather than an arbitrary one. Claims about
    // a number in a comment rot silently; this one is checkable, so check it.
    // (It was written as 304.3 first, from memory, and was wrong.)
    expect(hueFromHex("#8b5cf6")!).toBeCloseTo(292.7, 1);
  });
});

// ─── The contrast proof ──────────────────────────────────────────────────────
//
// The detail page seeds a palette from the cover art's hue, then re-derives
// every colour at a FIXED lightness and chroma chosen here. Only the angle
// comes from the artwork. This suite is the reason that is safe: it proves
// the derived colours clear WCAG at every hue the catalogue can produce, so
// the page cannot be given an unreadable palette by an unlucky poster.
//
// If you change the L or C in the --poster-tone* declarations in
// page.module.css, change them here too — these tests will tell you exactly
// which hues you broke.

/** Mirrors the `--poster-tone*` declarations. Keep in sync with page.module.css. */
const TONE = { L: 76, C: 0.085 };
const TONE_MID = { L: 52, C: 0.07 };
const TONE_LOW = { L: 24, C: 0.045 };

const SURFACES = {
  "--bg": hex("#000000"),
  "--bg-card": hex("#1c1c1e"),
  "--bg-elevated": hex("#2c2c2e"),
};

/** Every hue, one degree apart — the full space a cover can seed. */
const ALL_HUES = Array.from({ length: 360 }, (_, i) => i);

function worstContrast(
  tone: { L: number; C: number },
  surface: { r: number; g: number; b: number },
) {
  let worst = { ratio: Infinity, hue: -1 };
  for (const h of ALL_HUES) {
    const ratio = contrastRatio(oklchDegToRgb(tone.L, tone.C, h), surface);
    if (ratio < worst.ratio) worst = { ratio, hue: h };
  }
  return worst;
}

describe("the derived palette is legible at every hue", () => {
  for (const [name, surface] of Object.entries(SURFACES)) {
    test(`--poster-tone clears 4.5:1 on ${name}, all 360 hues`, () => {
      const worst = worstContrast(TONE, surface);
      expect(worst.ratio).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("--poster-tone-mid clears the 3:1 non-text threshold on --bg", () => {
    // Borders and dividers only — never text. 3:1 is the WCAG 1.4.11 bar for
    // a UI component boundary.
    expect(worstContrast(TONE_MID, SURFACES["--bg"]).ratio).toBeGreaterThanOrEqual(3);
  });

  test("--poster-tone-low stays a tint, never mistaken for a text colour", () => {
    // The assertion is deliberately upside-down: this token must be LOW
    // contrast. If someone raised its lightness until it read as text, it
    // would be used as text, and it is not contrast-managed for that.
    expect(worstContrast(TONE_LOW, SURFACES["--bg"]).ratio).toBeLessThan(3);
  });

  test("--poster-tone is readable on a --poster-tone-low fill at every hue", () => {
    // The one same-hue pairing the design actually uses: tinted chip, toned
    // text. Both move together with the hue, so a hue that darkened the fill
    // while lightening the text would only show up here.
    for (const h of ALL_HUES) {
      const ratio = contrastRatio(
        oklchDegToRgb(TONE.L, TONE.C, h),
        oklchDegToRgb(TONE_LOW.L, TONE_LOW.C, h),
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("76% is not a lucky guess — it carries real headroom", () => {
    // Finds the actual floor on the strictest surface, so a future edit that
    // trims lightness has a number to argue with instead of a vibe.
    const strictest = SURFACES["--bg-elevated"];
    let floor = TONE.L;
    for (let L = 40; L <= TONE.L; L += 1) {
      if (worstContrast({ L, C: TONE.C }, strictest).ratio >= 4.5) {
        floor = L;
        break;
      }
    }
    expect(floor).toBeLessThanOrEqual(68);
    expect(TONE.L - floor).toBeGreaterThanOrEqual(8);
  });
});

describe("why the raw sampled colour is not used directly", () => {
  // globals.css still hands `var(--poster-accent)` — the unmanaged colour
  // sampled off the artwork — straight to `color:` on .hero-relation-chip
  // hover. This test documents what that costs, and is the justification for
  // every --poster-tone* token above.
  const REAL_COVER_ACCENTS = [
    "#7caf62",
    "#e45d35",
    "#8b5cf6",
    "#2e6fbf",
    "#d4a017",
    "#c2185b",
  ];

  test("raw cover colours swing across the WCAG line", () => {
    const ratios = REAL_COVER_ACCENTS.map((c) => contrastRatio(hex(c), SURFACES["--bg"]));
    const failing = ratios.filter((r) => r < 4.5);
    // Two of these six are below 4.5:1 on pure black. That is the defect:
    // not that the colour is wrong, but that nothing bounds it.
    expect(failing.length).toBeGreaterThan(0);
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeGreaterThan(2);
  });

  test("re-deriving at a fixed lightness removes the swing entirely", () => {
    const ratios = REAL_COVER_ACCENTS.map((c) => {
      const h = hueFromHex(c);
      if (h === null) throw new Error(`${c} produced no hue`);
      return contrastRatio(oklchDegToRgb(TONE.L, TONE.C, h), SURFACES["--bg"]);
    });
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
    // Same six covers, now within a narrow band instead of 2.5x apart.
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.5);
  });
});
