import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// One focus ring, app-wide.
//
// DESIGN.md specifies it exactly once — `0 0 0 3px rgba(10,132,255,0.40)` —
// and says every interactive element draws that one. Before this suite there
// were four different rings in the tree:
//
//   · blue,  the specified one                    (Button, page.module.css)
//   · teal   #64d2ff                              (PlayButton dialog, HotDiscussions links)
//   · amber  #ff9f0a                              (HotDiscussions cards)
//   · the per-anime poster accent                 (HeroCarousel)
//
// Each looked deliberate in its own file. Together they are a ring that
// stops meaning "you are here" and starts reading as decoration — and two
// of them used colours this system reserves for something else: teal is
// read-only, amber is --warning.
//
// The carousel's was the worst of the four and the hardest to see in review:
// --hero-accent is sampled from whatever poster is on screen, so the focus
// ring changed colour as the carousel rotated, and on the wrong artwork it
// was invisible.
//
// This is a lint, not a unit test. It exists because the failure mode is
// per-file plausibility — nobody writing one component sees the other three.

const SRC = join(import.meta.dir, "../..");

/** The ring DESIGN.md specifies, whitespace-insensitive. */
const RING = /0\s+0\s+0\s+3px\s+rgba\(\s*10\s*,\s*132\s*,\s*255\s*,\s*0?\.4\d*\s*\)/;

function cssModules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssModules(full, out);
    else if (entry.endsWith(".module.css")) out.push(full);
  }
  return out;
}

/**
 * Every `:focus-visible` rule body in the tree, as
 * `{ file, selector, body }`.
 *
 * Comments are stripped first — this file's own prose names the colours it
 * bans, and several of the fixed rules explain what they used to be.
 */
function focusRules(): Array<{ file: string; selector: string; body: string }> {
  const found: Array<{ file: string; selector: string; body: string }> = [];
  for (const file of cssModules(SRC)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selector, body] of css.matchAll(
      /([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g,
    )) {
      found.push({
        file: file.slice(SRC.length + 1),
        selector: selector.trim().replace(/\s+/g, " "),
        body,
      });
    }
  }
  return found;
}

const rules = focusRules();

describe("the focus ring", () => {
  test("the scan finds rules at all (guards the parser, not the CSS)", () => {
    // Without this, a regex that quietly matched nothing would make every
    // assertion below pass forever.
    expect(rules.length).toBeGreaterThanOrEqual(5);
  });

  test("every :focus-visible rule draws the one specified ring", () => {
    const wrong = rules
      .filter((r) => !RING.test(r.body))
      .map((r) => `${r.file} — ${r.selector}`);
    expect(wrong).toEqual([]);
  });

  test("no rule paints the ring with a reserved or per-anime colour", () => {
    // Named individually because each was a real regression, and the error
    // message should say which mistake was made rather than "did not match".
    const offenders = rules
      .filter((r) => /#64d2ff|#5ac8fa|#ff9f0a|#30d158|--hero-accent|--poster-accent/.test(r.body))
      .map((r) => `${r.file} — ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  test("no rule removes the indicator outright", () => {
    // `outline: none` is fine in a rule that also draws the box-shadow ring;
    // `box-shadow: none` inside a :focus-visible block is not.
    const removed = rules
      .filter((r) => /box-shadow\s*:\s*none/.test(r.body))
      .map((r) => `${r.file} — ${r.selector}`);
    expect(removed).toEqual([]);
  });
});

describe("touch targets", () => {
  test("the shared Button meets the 44px floor", () => {
    // DESIGN.md > Touch Targets, which is Apple HIG's minimum. It was 40px,
    // and 42px in the dialog next to it — both close enough to look
    // considered while missing the number they were aiming at.
    const css = readFileSync(join(import.meta.dir, "Button.module.css"), "utf8");
    const min = css.match(/min-height:\s*(\d+)px/)?.[1];
    expect(min).toBeDefined();
    expect(Number(min)).toBeGreaterThanOrEqual(44);
  });
});
