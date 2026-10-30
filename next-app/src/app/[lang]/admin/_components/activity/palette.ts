import type { CSSProperties } from "react";
import type { DeltaKind } from "@/lib/activityChart";

// The activity panel's colours, in one place because three cards share them.
//
// The two series colours were validated against the card surface (#15151f)
// for lightness, chroma, adjacent-pair colour-blind separation and contrast;
// do not substitute by eye. They sit apart from every other palette on the
// admin page (the enrichment bar's, the synopsis tiers', the zh-Hant block's),
// and red is deliberately absent: the page reserves it for alarms.
//
// Every per-datum treatment — a bar's hatch, today's dashed outline, a cohort
// cell's shade — is applied inline from here rather than through a class, so
// the render tests can see it (bun resolves a CSS module to its file path, so
// class names do not exist under test).

/** People active on a day that is not their signup day. */
export const COLOR_RETURNING = "#3d90dd";
/** People active on their signup day. */
export const COLOR_SIGNUP_DAY = "#e0559b";

/**
 * Days before per-request recording: the same hue at half strength under a
 * 45° hatch. Same hue because it is the same measure with weaker evidence;
 * the hatch keeps the difference from resting on colour alone.
 */
export const HATCH_RETURNING =
  "repeating-linear-gradient(45deg, rgba(61,144,221,0.55) 0 2px, rgba(61,144,221,0.12) 2px 5px)";
export const HATCH_SIGNUP_DAY =
  "repeating-linear-gradient(45deg, rgba(224,85,155,0.55) 0 2px, rgba(224,85,155,0.12) 2px 5px)";

/** Laid over a cohort cell's shade when the week predates instrumentation. */
export const HATCH_CELL = "repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 2px, transparent 2px 6px)";

/** Today's bar: the day is not over, so it is drawn half-strength with a dashed edge. */
export const LIVE_STACK: CSSProperties = {
  opacity: 0.5,
  outline: "1px dashed #8cc2f0",
  outlineOffset: 1,
};

export const LIVE_SWATCH: CSSProperties = {
  background: "rgba(61,144,221,0.45)",
  outline: "1px dashed #8cc2f0",
  outlineOffset: 1,
};

/** A cohort horizon that is not over yet. */
export const PENDING_BORDER = "1px dashed #3a3a4c";

/** Up is good news, down is amber (never red: nothing here is an alarm). */
export const DELTA_COLOR: Record<DeltaKind, string> = {
  up: "#30d158",
  down: "#ff9f0a",
  flat: "#a8a8b8",
};

/** An eligible cohort cell's background, from cohortShade(). */
export function cellShade(alpha: number): string {
  return `rgba(61,144,221,${alpha.toFixed(3)})`;
}

/** Joins class names, dropping the falsy ones. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
