import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Button is a class name and a <button>. There is no DOM testing library in
// this repo, so what can be asserted is the seam between its two halves —
// and that seam has a silent failure mode.
//
// `className={styles[variant]}` resolves to `undefined` for any variant the
// stylesheet does not define, and React renders `class="undefined"`. The
// result is a completely unstyled button: no padding, no background, no
// touch target, no focus ring. Nothing throws, nothing warns, and TypeScript
// is satisfied because the type union is where the variant came from.
//
// So the check is that the union and the stylesheet agree, in both
// directions.

const TSX = readFileSync(join(import.meta.dir, "Button.tsx"), "utf8");
const CSS_RAW = readFileSync(join(import.meta.dir, "Button.module.css"), "utf8");

// Comments stripped before anything is matched. This file's stylesheet
// explains its own decisions in prose, and that prose names the selectors it
// decided against — the first version of the assertion below failed because
// it found `.base:active` inside the comment saying why `.base:active` is
// wrong. A source-reading test has to read code, not the notes about it.
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, "");

// Rules outside any @media block. The reduced-motion block re-states hover
// selectors to cancel their transform, which is harmless on a disabled
// button and would otherwise trip the :not(:disabled) check below.
const CSS_TOPLEVEL = CSS.replace(/@media[^{]*\{[\s\S]*?\n\}/g, "");

/** The members of the `ButtonVariant` union, from the source. */
function declaredVariants(): string[] {
  const union = TSX.match(/export type ButtonVariant\s*=\s*([^;]+);/)?.[1] ?? "";
  return [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

/** Class names the stylesheet defines. */
function definedClasses(): Set<string> {
  return new Set([...CSS.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]));
}

const variants = declaredVariants();
const classes = definedClasses();

describe("variants", () => {
  test("the parse found something (guards the regexes, not the code)", () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true — the standard failure of a test that reads source.
    expect(variants.length).toBeGreaterThanOrEqual(3);
    expect(classes.size).toBeGreaterThanOrEqual(4);
  });

  test("every variant in the type has a class in the stylesheet", () => {
    // The silent one: a missing class renders class="undefined", which is a
    // button with no padding, no background and no focus ring.
    const missing = variants.filter((v) => !classes.has(v));
    expect(missing).toEqual([]);
  });

  test("every variant class composes the shared base", () => {
    // `composes: base` is what carries the 44px touch target and the focus
    // ring. A variant that declares its own box from scratch would look
    // right and fail both.
    for (const v of variants) {
      const rule = CSS.match(new RegExp(`\\.${v}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule).toContain("composes: base");
    }
  });
});

describe("the states the base cannot get right for everyone", () => {
  test("confirm cancels the disabled dimming", () => {
    // ShareButton renders the "copied" confirmation as a disabled button so
    // it is not clickable — which means it inherits `.base:disabled`'s
    // opacity 0.35. It is a message with about two seconds to be read, not a
    // switched-off control. Without this override it ships at 35% opacity
    // and nobody notices in review, because you have to click share and look
    // within two seconds.
    const rule = CSS.match(/\.confirm:disabled\s*\{([^}]*)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/opacity:\s*1\b/);
  });

  test("the pressed state is per-variant, not on the base", () => {
    // `.base:active` ties `.primary:hover` on specificity and loses on
    // source order, so a base-level press would never show for a mouse — and
    // a mouse press is always also a hover. This asserts the shape that
    // works rather than the one that reads more naturally.
    expect(CSS).not.toMatch(/\.base:active/);
    expect(CSS).toMatch(/\.primary:active/);
    expect(CSS).toMatch(/\.outline:active/);
    // The comment stripping is what makes the negative assertion meaningful —
    // the raw file DOES contain that string, in the note explaining why.
    expect(CSS_RAW).toMatch(/\.base:active/);
  });

  test("hover and active are gated on :not(:disabled)", () => {
    // A disabled button that still lifts under the pointer reads as broken
    // rather than as off.
    const gated = [...CSS_TOPLEVEL.matchAll(/(\.\w+:(?:hover|active)[^{,]*)[,{]/g)].map(
      (m) => m[1],
    );
    expect(gated.length).toBeGreaterThanOrEqual(4);
    for (const selector of gated) expect(selector).toContain(":not(:disabled)");
  });
});
