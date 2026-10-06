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

/**
 * True when `:focus-visible` sits on the element the rule styles — the
 * rightmost compound selector — rather than on an ancestor.
 *
 * `.bar:focus-visible .barTip { opacity: 1 }` reveals a tooltip while its bar
 * has focus; it does not draw the bar's focus indicator, so demanding the ring
 * inside it would paint a blue ring around the tooltip. The indicator for the
 * bar is `.bar:focus-visible`, which this still checks.
 */
function focusIsSubject(selectorList: string): boolean {
  return selectorList.split(",").some((selector) => {
    const compounds = selector.trim().split(/\s*[>+~]\s*|\s+/);
    return compounds[compounds.length - 1].includes(":focus-visible");
  });
}

/** Everything inside `:has(…)`, one level of nested parentheses deep. */
const HAS_ARGUMENT = /:has\((?:[^()]|\([^()]*\))*\)/g;

/**
 * True when the rule is a focus indicator, i.e. what this suite holds to the
 * ring and to the forced-colors outline.
 *
 * `X:has(:focus-visible)` styles X because something INSIDE it has focus, so
 * by itself it says nothing about drawing an indicator. It is one when it
 * draws one: the search pill's ring around its field
 * (`.pill:has(.input:focus-visible)`) is the field's indicator and is held to
 * the ring like any other. The site header showing itself when keyboard focus
 * lands in it while tucked away (`.bar[data-hidden="true"]:has(:focus-visible)`,
 * a transform) is not, and demanding the ring there would paint one around
 * the whole bar — the tooltip case above, written with :has().
 */
function isIndicator(rule: { selector: string; body: string }): boolean {
  if (!focusIsSubject(rule.selector)) return false;
  const outsideHas = rule.selector.replace(HAS_ARGUMENT, "");
  if (outsideHas.includes(":focus-visible")) return true;
  return /(^|[;\s])(box-shadow|outline)\s*:/.test(rule.body);
}

describe("the focus ring", () => {
  test("the scan finds rules at all (guards the parser, not the CSS)", () => {
    // Without this, a regex that quietly matched nothing would make every
    // assertion below pass forever.
    expect(rules.length).toBeGreaterThanOrEqual(5);
  });

  test("a :has() rule counts as an indicator only when it draws one", () => {
    // Pins isIndicator itself, so loosening it cannot quietly let real
    // indicators through.
    const ring = "box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.4);";
    expect(isIndicator({ selector: ".pill:has(.input:focus-visible)", body: ring })).toBe(true);
    expect(isIndicator({ selector: ".pill:has(.input:focus-visible)", body: "outline: none;" })).toBe(true);
    expect(
      isIndicator({ selector: '.bar[data-hidden="true"]:has(:focus-visible)', body: "transform: none;" }),
    ).toBe(false);
    expect(isIndicator({ selector: ".x:focus-visible", body: "color: red;" })).toBe(true);
    expect(isIndicator({ selector: ".x:has(.y):focus-visible", body: "color: red;" })).toBe(true);
    expect(isIndicator({ selector: ".bar:focus-visible .barTip", body: ring })).toBe(false);
  });

  test("every :focus-visible rule draws the one specified ring", () => {
    const wrong = rules
      .filter(isIndicator)
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
    // `box-shadow: none` inside a :focus-visible block takes the ring away.
    // Clearing the outline is the subject of the forced-colors test below.
    const removed = rules
      .filter((r) => /box-shadow\s*:\s*none/.test(r.body))
      .map((r) => `${r.file} — ${r.selector}`);
    expect(removed).toEqual([]);
  });

  test("forced-colors mode still has an indicator", () => {
    // Windows Contrast themes (forced-colors: active) force box-shadow to
    // none, so a rule whose only indicator is the ring shows nothing there.
    // `outline: none` / `outline: 0` throws away the one thing the browser
    // could still paint. `outline: 2px solid transparent` keeps an outline
    // that is invisible normally and drawn in the system colour in that mode
    // (Button.module.css) — the ring above stays the visible indicator.
    const bare = rules
      .filter(isIndicator)
      .filter((r) => /outline\s*:\s*(none|0)\s*(;|$)/.test(r.body))
      .map((r) => `${r.file} — ${r.selector}`);
    expect(bare).toEqual([]);
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
