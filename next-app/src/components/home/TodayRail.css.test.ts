import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Today's shows suddenly disappear."
//
// On a phone the rail used to fold its aired half behind one tile, with
//
//   .rail[data-aired="collapsed"] .card[data-state="aired"] { display: none; }
//
// and the rail re-slots its cards on every minute tick. So a card that aired
// while the page was open flipped to data-state="aired" at its airing minute
// and dropped out of the row — exactly when a reader was waiting for it.
//
// The fold is gone. This is a lint over the stylesheets the rail's cards wear,
// so that no width (no @media block) can hide a card again: a rule whose
// subject is a card, or that keys on a card's state, may not take it off the
// page. A render test cannot see this — the markup was always complete; the
// card was hidden by CSS.

const FILES = ["TodayRail.module.css", "cards.module.css"];

/** Rules that remove an element from the page, as opposed to restyling it. */
const HIDES = /(?:^|[;{\s])(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)/;

/** A selector that reaches a rail card: its class, or the state the clock flips. */
const TARGETS_CARD = /\.card\b|data-state/;

interface Rule {
  file: string;
  selector: string;
  body: string;
}

function rulesOf(file: string, css: string): Rule[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    file,
    selector: selector.trim().replace(/\s+/g, " "),
    body,
  }));
}

function hidesACard(rule: Rule): boolean {
  return TARGETS_CARD.test(rule.selector) && HIDES.test(rule.body);
}

const rules = FILES.flatMap((file) => rulesOf(file, readFileSync(join(import.meta.dir, file), "utf8")));

describe("the today rail's stylesheets", () => {
  test("the scan finds the card rules at all (guards the parser, not the CSS)", () => {
    expect(rules.filter((r) => /\.card\b/.test(r.selector)).length).toBeGreaterThanOrEqual(3);
  });

  test("the check recognises the rule that used to hide aired cards", () => {
    const old = rulesOf(
      "old",
      `@media (max-width: 600px) { .rail[data-aired="collapsed"] .card[data-state="aired"] { display: none; } }`,
    );
    expect(old.some(hidesACard)).toBe(true);
    // …and lets an ordinary card rule through.
    expect(rulesOf("ok", ".card { flex: none; width: 148px; }").some(hidesACard)).toBe(false);
  });

  test("no rule, at any width, hides a card", () => {
    expect(rules.filter(hidesACard).map((r) => `${r.file} — ${r.selector}`)).toEqual([]);
  });
});
