import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gate that keeps DESIGN.md and globals.css from drifting apart again.
//
// They had. Before this suite existed the spec defined 31 tokens and the
// stylesheet declared 10 of them, six of those with the wrong value — and
// nothing anywhere said so, because a missing custom property is not an
// error in CSS. `var(--sp-lg)` against an undeclared token silently resolves
// to nothing and the declaration is dropped, so the failure mode of this
// particular drift is a component that looks *almost* right.
//
// The consequence was not cosmetic: with two thirds of the vocabulary
// absent, every component that needed a radius or a spacing step hardcoded a
// literal, and the design system ended up existing only as a document.
// Measured at the time: across all of src/, `--accent` had 9 references,
// `--bg` and `--text` one each, and the rest of the palette had zero.
//
// Two assertions, doing different jobs:
//
//   · completeness — every token DESIGN.md names is declared. Parsed from
//     the spec, so adding a token to the document is enough to make this
//     fail until the stylesheet catches up. This is the drift that happened.
//
//   · values — an explicit table. A second copy, deliberately: it is what
//     catches someone editing globals.css directly, which the parsed check
//     cannot see (a wrong value is still a declaration).

const CSS = readFileSync(join(import.meta.dir, "globals.css"), "utf8");
const DESIGN = readFileSync(join(import.meta.dir, "../../../DESIGN.md"), "utf8");

/** The `:root` block — the only place tokens may be declared. */
const ROOT = CSS.slice(CSS.indexOf(":root"), CSS.indexOf("\n}", CSS.indexOf(":root")));

/** Every `--token: value` declared in `:root`, comments stripped. */
function declaredTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of ROOT.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(
    /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi,
  )) {
    out.set(name, value.trim());
  }
  return out;
}

/** Every `--token` DESIGN.md mentions inside a backtick. */
function specifiedTokens(): Set<string> {
  return new Set([...DESIGN.matchAll(/`(--[a-z0-9-]+)`/gi)].map((m) => m[1]));
}

const declared = declaredTokens();
const specified = specifiedTokens();

/**
 * Tokens the stylesheet owns that DESIGN.md does not describe.
 *
 * These are runtime mechanics rather than palette: the poster accent is
 * sampled from cover art (DESIGN.md documents the concept but the halo
 * timings are implementation), and the accent hover/active steps are given
 * in the Buttons section as bare hex without a token name.
 */
const NOT_IN_SPEC = new Set([
  "--poster-accent",
  "--poster-accent-rgb",
  "--duration-halo-in",
  "--duration-halo-in-fast",
  "--delay-halo-appear",
  "--accent-hover",
  "--accent-active",
  "--font-display",
  "--font-sans",
  "--font-mono",
  "--ease-out-expo",
]);

describe("completeness", () => {
  test("every token DESIGN.md names is declared in globals.css", () => {
    const missing = [...specified].filter((t) => !declared.has(t)).sort();
    expect(missing).toEqual([]);
  });

  test("the spec is actually being read (guards the parser, not the CSS)", () => {
    // Without this, a regex that silently matched nothing would make the
    // check above pass forever — the failure mode of every "parse the docs"
    // test. 31 is the count at the time of writing; it may only grow.
    expect(specified.size).toBeGreaterThanOrEqual(31);
    expect(specified.has("--sp-lg")).toBe(true);
    expect(specified.has("--radius-full")).toBe(true);
  });

  test("globals.css declares nothing outside the spec but the documented mechanics", () => {
    // The reverse direction. A token invented in CSS and never written down
    // is how the next palette starts drifting.
    const undocumented = [...declared.keys()]
      .filter((t) => !specified.has(t) && !NOT_IN_SPEC.has(t))
      .sort();
    expect(undocumented).toEqual([]);
  });
});

describe("values", () => {
  // Straight from DESIGN.md's tables. Whitespace inside rgba() is normalised
  // before comparing, since the stylesheet is prettier-formatted and the
  // document is not.
  const EXPECTED: Record<string, string> = {
    "--bg": "#000000",
    "--bg-card": "#1c1c1e",
    "--bg-elevated": "#2c2c2e",
    "--bg-fill": "rgba(120,120,128,0.12)",
    "--separator": "rgba(84,84,88,0.65)",
    "--separator-opaque": "#38383a",

    "--accent": "#0a84ff",
    "--accent-dim": "rgba(10,132,255,0.12)",

    "--teal": "#5ac8fa",
    "--teal-dim": "rgba(90,200,250,0.10)",

    "--text": "#ffffff",
    "--text-secondary": "rgba(235,235,245,0.60)",
    "--text-tertiary": "rgba(235,235,245,0.30)",
    "--text-quaternary": "rgba(235,235,245,0.18)",

    "--success": "#30d158",
    "--warning": "#ff9f0a",
    "--error": "#ff453a",
    "--info": "#5ac8fa",

    "--sp-xs": "4px",
    "--sp-sm": "8px",
    "--sp-md": "16px",
    "--sp-lg": "24px",
    "--sp-xl": "32px",
    "--sp-2xl": "48px",
    "--sp-3xl": "64px",

    "--radius-sm": "8px",
    "--radius": "12px",
    "--radius-lg": "16px",
    "--radius-xl": "20px",
    "--radius-full": "9999px",

    "--score-high-fg": "#30d158",
    "--score-high-bg": "rgba(48,209,88,0.12)",
    "--score-mid-fg": "#ff9f0a",
    "--score-mid-bg": "rgba(255,159,10,0.12)",
    "--score-low-fg": "#ff453a",
    "--score-low-bg": "rgba(255,69,58,0.12)",
    "--score-scrim-bg": "rgba(0,0,0,0.75)",
  };

  const strip = (v: string) => v.replace(/\s+/g, "").toLowerCase();

  for (const [token, want] of Object.entries(EXPECTED)) {
    test(`${token} is ${want}`, () => {
      expect(declared.get(token)).toBeDefined();
      expect(strip(declared.get(token)!)).toBe(strip(want));
    });
  }

  test("the count is what the spec says it is", () => {
    // 21 tokens were added in one commit to close this gap. Pinning the
    // total makes a silent deletion fail rather than shrinking the palette
    // back toward where it started.
    expect(Object.keys(EXPECTED)).toHaveLength(37);
  });
});

describe("semantic coupling", () => {
  test("--info and --teal are the same colour", () => {
    // Informational IS the read-only case. They are two names for one role;
    // letting them drift apart would be the bug, not the fix.
    expect(declared.get("--info")).toBe(declared.get("--teal")!);
  });

  test("each score band's foreground matches its semantic colour", () => {
    // The bands are not a private palette — they are --success / --warning /
    // --error under a task-specific name. If they drift, a "good" score
    // stops being the same green as every other success on the site.
    expect(declared.get("--score-high-fg")).toBe(declared.get("--success")!);
    expect(declared.get("--score-mid-fg")).toBe(declared.get("--warning")!);
    expect(declared.get("--score-low-fg")).toBe(declared.get("--error")!);
  });

  test("every score band declares both halves", () => {
    // The shape of the production defect: a foreground with no matching
    // background is what let the page pair green text with an amber pill.
    for (const band of ["high", "mid", "low"]) {
      expect(declared.has(`--score-${band}-fg`)).toBe(true);
      expect(declared.has(`--score-${band}-bg`)).toBe(true);
    }
  });
});
