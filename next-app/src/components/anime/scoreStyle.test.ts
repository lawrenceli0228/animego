import { describe, expect, test } from "bun:test";
import {
  SCORE_THRESHOLDS,
  scoreBadgeStyle,
  scoreBand,
  scoreScrimStyle,
} from "./scoreStyle";

// The regression guard for a defect that reached production and stayed:
// every anime rated 75 or above rendered green text on an amber pill, on the
// site's highest-traffic page. The foreground came from a threshold ladder;
// the background was a hardcoded literal one screen away. Neither piece was
// wrong on its own, which is why no review caught it — and why the assertion
// that matters is not "the colours are right" but "the two came from the
// same band".
//
// This file can exist at all because scoreStyle.ts is a module. The page it
// came out of cannot be imported: page.tsx reaches react-hot-toast, which
// touches `document` at module scope, so a suite importing it dies before
// its first assertion. Asserting on the page's source text instead would be
// theatre — it would pass on a file that renders nothing.

describe("bands", () => {
  test("the ladder is high / mid / low, split at the documented thresholds", () => {
    expect(scoreBand(100)).toBe("high");
    expect(scoreBand(75)).toBe("high");
    expect(scoreBand(74)).toBe("mid");
    expect(scoreBand(50)).toBe("mid");
    expect(scoreBand(49)).toBe("low");
    expect(scoreBand(0)).toBe("low");
  });

  test("the boundaries are inclusive on the upper band", () => {
    // Stated separately because ">= vs >" is the whole content of this
    // function, and an off-by-one here is invisible on screen: it moves
    // exactly the scores sitting on 75 and 50.
    expect(scoreBand(SCORE_THRESHOLDS.high)).toBe("high");
    expect(scoreBand(SCORE_THRESHOLDS.high - 1)).toBe("mid");
    expect(scoreBand(SCORE_THRESHOLDS.mid)).toBe("mid");
    expect(scoreBand(SCORE_THRESHOLDS.mid - 1)).toBe("low");
  });

  test("thresholds match the Rating Bands table in DESIGN.md", () => {
    // Literals on purpose. Reading them from the same constants they check
    // would assert nothing; these two numbers are site-wide semantics and
    // changing them is a design decision, not a refactor.
    expect(SCORE_THRESHOLDS.high).toBe(75);
    expect(SCORE_THRESHOLDS.mid).toBe(50);
  });
});

describe("the tinted badge — background and text are the same band", () => {
  // The exact assertion the production bug would have failed. Not "is it
  // green" — the pill was genuinely green, that was never the problem — but
  // "does the background name the same band as the text".
  const cases = [
    { score: 90, band: "high" },
    { score: 75, band: "high" },
    { score: 60, band: "mid" },
    { score: 50, band: "mid" },
    { score: 30, band: "low" },
    { score: 0, band: "low" },
  ] as const;

  for (const { score, band } of cases) {
    test(`${score} paints the ${band} pair and nothing mixed`, () => {
      const style = scoreBadgeStyle(score);
      expect(style.color).toBe(`var(--score-${band}-fg)`);
      expect(style.background).toBe(`var(--score-${band}-bg)`);
    });
  }

  test("every score in 0..100 gets a matching pair", () => {
    // The loop is the point: the bug lived at 75..100, a range no single
    // hand-picked example was covering.
    for (let score = 0; score <= 100; score++) {
      const { color, background } = scoreBadgeStyle(score);
      const fgBand = String(color).match(/--score-(\w+)-fg/)?.[1];
      const bgBand = String(background).match(/--score-(\w+)-bg/)?.[1];
      expect(fgBand).toBeDefined();
      expect(bgBand).toBe(fgBand!);
    }
  });

  test("it returns only the two coupled properties", () => {
    // Padding, radius and the mono face belong to the badge's own rule. If
    // layout leaks back in here, the next caller starts spreading this over
    // its own layout and the coupling argument stops holding.
    expect(Object.keys(scoreBadgeStyle(80)).sort()).toEqual(["background", "color"]);
  });
});

describe("the over-artwork badge", () => {
  test("keeps the band foreground but always the opaque scrim", () => {
    // A 12% tint has no contrast guarantee over a cover that could be any
    // colour, so this variant deliberately does NOT vary its background.
    for (const score of [95, 60, 20]) {
      const style = scoreScrimStyle(score);
      expect(style.background).toBe("var(--score-scrim-bg)");
      expect(style.color).toBe(`var(--score-${scoreBand(score)}-fg)`);
    }
  });

  test("never returns a band background", () => {
    // The mistake this prevents is reaching for scoreBadgeStyle on a card:
    // it would look almost right in review and be unreadable on a bright
    // poster.
    // Matching on the band names, not on "-bg", because the scrim token is
    // itself called --score-scrim-bg.
    for (let score = 0; score <= 100; score += 5) {
      expect(String(scoreScrimStyle(score).background)).not.toMatch(
        /--score-(high|mid|low)-bg/,
      );
    }
  });
});
