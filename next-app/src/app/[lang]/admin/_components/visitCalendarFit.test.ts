import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The drawer's 90-day visit calendar has to fit a phone: up to fourteen week
// columns and the weekday labels inside the drawer's content box, today's
// outlined cell included. At 390px it used to run 20px past the content edge
// (32px in English), and today's column was cut off by the screen.
//
// The browser does the layout, so this is a lint over userDetail.module.css
// rather than a measurement: it reads the numbers the stylesheet uses at a
// given viewport width and adds up the widest calendar. The text widths are
// measured ones (Chromium, the drawer's font, 10.5px): the widest weekday
// label, "Wed", about 21px, and the widest month label, "11月", about 24.5px,
// which can sit over the last column and run past it.

const WEEKDAY_LABEL_PX = 22;
const MONTH_LABEL_PX = 25;
const TODAY_OUTLINE_PX = 1;
const COLUMNS = 14;

const css = readFileSync(join(import.meta.dir, "userDetail.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of `@media (<query>) { … }`, braces balanced. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) throw new Error(`no @media ${query}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced @media ${query}`);
}

/** Declarations of the first rule for exactly `selector` in `scope`. */
function rule(scope: string, selector: string): Record<string, string> {
  const m = new RegExp(`(?:^|[}\\s])${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(scope);
  if (!m) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    m[1]
      .split(";")
      .map((d) => d.split(/:(.*)/s).map((s) => s.trim()))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, v]),
  );
}

/** A px / vw length expression — min(), max(), calc() and arithmetic — at a viewport width. */
function px(expr: string, viewport: number): number {
  const js = expr
    .replace(/(\d+(?:\.\d+)?)vw/g, (_, n) => String((Number(n) * viewport) / 100))
    .replace(/(\d+(?:\.\d+)?)px/g, "$1")
    .replace(/calc\(/g, "(")
    .replace(/\b(min|max)\(/g, "Math.$1(");
  if (!/^[\d.\s+\-*/(),]*$/.test(js.replace(/Math\.(min|max)/g, ""))) throw new Error(`cannot evaluate ${expr}`);
  return Number(new Function(`return (${js});`)());
}

const base = rule(css, ".cal");
const narrow = mediaBlock("(max-width: 640px)");

function calendarAt(viewport: number) {
  const phone = viewport <= 640;
  const cal = phone ? { ...base, ...rule(narrow, ".cal") } : base;
  const cell = px(cal["--cal-cell"], viewport);
  const gap = px(cal["--cal-gap"], viewport);
  const labelGap = px(base.gap, viewport);
  // The drawer is min(560px, 100%) wide with a 1px left border; the body's
  // side padding is the narrow rule's on a phone.
  const padding = (phone ? rule(narrow, ".drawerBody") : rule(css, ".drawerBody")).padding.split(/\s+/).map((v) => px(v, viewport));
  const content = Math.min(560, viewport) - 1 - 2 * padding[1];
  const lastColumn = WEEKDAY_LABEL_PX + labelGap + (COLUMNS - 1) * (cell + gap);
  const width = lastColumn + Math.max(cell + TODAY_OUTLINE_PX, MONTH_LABEL_PX);
  return { cell, width, content };
}

describe("the visit calendar fits the drawer", () => {
  test("every part of it is sized by the two variables a phone can shrink", () => {
    expect(rule(css, ".calCell").width).toBe("var(--cal-cell)");
    expect(rule(css, ".calCell").height).toBe("var(--cal-cell)");
    expect(rule(css, ".calRows")["grid-template-rows"]).toBe("repeat(7, var(--cal-cell))");
    expect(rule(css, ".calRows").gap).toBe("var(--cal-gap)");
    expect(rule(css, ".calWeeks").gap).toBe("var(--cal-gap)");
    expect(rule(css, ".calWeek").gap).toBe("var(--cal-gap)");
  });

  for (const viewport of [320, 360, 375, 390, 430, 640, 1280]) {
    test(`${viewport}px: fourteen columns inside the content box`, () => {
      const { cell, width, content } = calendarAt(viewport);
      expect(width, `${COLUMNS} columns of ${cell.toFixed(1)}px need ${width.toFixed(1)}px of ${content}px`).toBeLessThanOrEqual(content);
    });
  }

  test("cells stay full size wherever they already fitted", () => {
    expect(calendarAt(1280).cell).toBe(22);
    expect(calendarAt(640).cell).toBe(22);
    expect(calendarAt(390).cell).toBeGreaterThanOrEqual(18);
  });
});
