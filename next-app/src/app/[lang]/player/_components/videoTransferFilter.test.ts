import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gate on a correction that fails silently in both directions.
//
// The transfer correction is split across two files by necessity: the SVG
// filter has to be in the DOM (VideoPlayer.tsx renders it) and the rule that
// applies it has to be in the stylesheet (globals.css), joined only by a
// string id. Neither half complains if the join breaks:
//
//   · a `filter: url(#id)` whose target does not exist renders the video
//     *uncorrected* in Chrome — no console error, no thrown exception, just
//     the grey picture back again;
//   · an unreferenced <filter> in the DOM is inert and invisible.
//
// So the only observable symptom of a rename on either side is "the picture
// looks a bit flat", which is precisely the complaint that took a wedge chart
// and a pixel-level A/B against ffmpeg to pin down in the first place. It is
// not something a reviewer will catch by reading a diff.
//
// Three assertions, doing different jobs:
//
//   · the id agrees across both files, in both rules;
//   · the fullscreen rule still names the transfer filter. `filter` is a
//     single property, so the more specific fullscreen rule silently replaces
//     the base one — writing just `opacity(0.999)` there would drop the
//     correction in fullscreen only, which is both the hardest case to notice
//     and the one people actually watch in;
//   · the table is a well-formed monotonic ramp from 0 to 1. A table that
//     does not start at 0 lifts black, one that does not end at 1 clips
//     white, and a non-monotonic one posterises — all of which look like
//     "the correction is wrong" rather than "the table is malformed".

const COMPONENT = readFileSync(
  join(import.meta.dir, "VideoPlayer.tsx"),
  "utf8",
);
const CSS = readFileSync(
  join(import.meta.dir, "../../../globals.css"),
  "utf8",
);

/** The id the component declares on its <filter>. */
function declaredId(): string {
  const m = COMPONENT.match(
    /const VIDEO_TRANSFER_FILTER_ID\s*=\s*"([^"]+)"/,
  );
  if (!m) throw new Error("VIDEO_TRANSFER_FILTER_ID not found in VideoPlayer.tsx");
  return m[1];
}

/**
 * The table values, as numbers. Written in source as concatenated string
 * literals so the line stays readable, so join the pieces back before parsing.
 */
function declaredTable(): number[] {
  const m = COMPONENT.match(
    /const VIDEO_TRANSFER_TABLE\s*=\s*([\s\S]*?);\n/,
  );
  if (!m) throw new Error("VIDEO_TRANSFER_TABLE not found in VideoPlayer.tsx");
  const joined = [...m[1].matchAll(/"([^"]*)"/g)].map((p) => p[1]).join("");
  return joined.trim().split(/\s+/).map(Number);
}

/** Every `filter:` declaration in globals.css that targets a player <video>. */
function videoFilterRules(): string[] {
  const out: string[] = [];
  for (const [, selector, body] of CSS.matchAll(
    /([^{}]*\bvideo\b[^{}]*)\{([^}]*)\}/g,
  )) {
    if (!/\.art-video-player/.test(selector)) continue;
    const filter = body.match(/(?:^|;|\*\/)\s*filter\s*:\s*([^;]+);/);
    if (filter) out.push(filter[1].trim());
  }
  return out;
}

describe("video transfer filter", () => {
  test("every player-video filter rule references the id the component renders", () => {
    const id = declaredId();
    const rules = videoFilterRules();

    // Two rules today: the base one and the fullscreen one. If a third
    // appears it is held to the same standard rather than silently exempt.
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) {
      expect(rule).toContain(`url(#${id})`);
    }
  });

  test("the component actually renders a filter with that id", () => {
    const id = declaredId();
    expect(COMPONENT).toContain("id={VIDEO_TRANSFER_FILTER_ID}");
    // sRGB is load-bearing — the SVG default is linearRGB, which would apply
    // the table in the wrong space and produce a different picture entirely.
    expect(COMPONENT).toContain('colorInterpolationFilters="sRGB"');
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test("the fullscreen rule keeps the transfer filter alongside opacity", () => {
    const fullscreen = videoFilterRules().find((r) => r.includes("opacity("));
    expect(fullscreen).toBeDefined();
    // Both, in one declaration. Either alone is a regression: dropping url()
    // loses the correction in fullscreen, dropping opacity() walks back the
    // subtitle-flicker fix (#24) on an untested assumption.
    expect(fullscreen).toContain(`url(#${declaredId()})`);
    expect(fullscreen).toContain("opacity(0.999)");
  });

  test("the table is a monotonic ramp across the full range", () => {
    const table = declaredTable();

    // 17 entries — the sampling the curve was measured and fitted at.
    expect(table).toHaveLength(17);
    expect(table.every(Number.isFinite)).toBe(true);
    expect(table[0]).toBe(0);
    expect(table[table.length - 1]).toBe(1);
    for (const v of table) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < table.length; i++) {
      expect(table[i]).toBeGreaterThan(table[i - 1]);
    }
  });

  test("the table darkens the midtones, which is the whole point", () => {
    const table = declaredTable();
    const last = table.length - 1;
    const identity = (i: number) => i / last;

    // Chrome pushes the middle of the range up, so the correction pulls it
    // back down. A table that drifted toward identity would satisfy every
    // structural check above while quietly doing nothing, so assert the shape
    // itself.
    for (let i = 2; i < last; i++) {
      expect(table[i]).toBeLessThan(identity(i));
    }
    const middle = table[last / 2];
    expect(0.5 - middle).toBeGreaterThan(0.02);

    // The deepest step is the exception, and deliberately so: Chrome does not
    // lift the bottom of the range — measured, it nudges code 17 down to 16 —
    // so the inverse nudges it back up. This is exactly where a fitted
    // `type="gamma"` curve went wrong (it assumed a shadow lift that is not
    // there and crushed 17 to 10), which is why the table is measured rather
    // than derived. Bounded so a genuinely wrong value still fails.
    expect(table[1]).toBeGreaterThan(identity(1));
    expect(table[1] - identity(1)).toBeLessThan(0.02);
  });
});
