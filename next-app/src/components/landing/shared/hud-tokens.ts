"use client";

import { useEffect, useRef, useState } from "react";
import {
  animate as animateValue,
  useInView,
  useReducedMotion,
} from "motion/react";

/**
 * Shared viewport margin for useInView-driven entrances across landing
 * sections + player chrome. Change once here, all surfaces follow.
 */
export const HUD_VIEWPORT = { once: true, margin: "-15% 0px" } as const;

/**
 * Section hue registry — each landing chapter owns one primary hue.
 */
export const HUE = {
  s01: 330, // Magenta Proof — hero identity
  s02: 210, // Data Blue — stats
  s03: 40, // Amber Archive — data-sources tribute
  s06: 260, // Violet Caliper — differentiator
  s07: 195, // LIVE Cyan — danmaku
  s08: 70, // Chartreuse Clear — FAQ
  s09: 40, // Ember — final CTA
} as const;

export const PLAYER_HUE = {
  stream: 210,
  ingest: 210,
  status: 200,
  live: 140,
  local: 210,
} as const;

export const LIBRARY_HUE = {
  unclassified: 40,
} as const;

export const LOCAL_HEX_GLYPH = "⬡";
export const LOCAL_BADGE_COLOR = "#5ac8fa";
export const PROGRESS_FILL = "#0a84ff";
export const PROGRESS_TRACK = `oklch(62% 0.17 ${PLAYER_HUE.local} / 0.25)`;

export const L = {
  trench: 14,
  rail: 46,
  primary: 62,
  readout: 72,
  hot: 82,
  flash: 92,
} as const;

export const C = {
  trench: 0.04,
  rail: 0.06,
  primary: 0.17,
  readout: 0.14,
  hot: 0.16,
  flash: 0.08,
} as const;

type LayerKey = keyof typeof L;

export function oklchToken(layer: LayerKey, hue: number, alpha?: number): string {
  const l = L[layer];
  const c = C[layer];
  if (alpha == null) return `oklch(${l}% ${c} ${hue})`;
  return `oklch(${l}% ${c} ${hue} / ${alpha})`;
}

export const mono = {
  fontFamily: "'JetBrains Mono', monospace",
  letterSpacing: "0.06em",
  fontVariantNumeric: "tabular-nums",
} as const;

export const label = {
  ...mono,
  fontSize: 10,
  color: "rgba(235,235,245,0.45)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
} as const;

interface CountUpOpts {
  duration?: number;
  delay?: number;
  format?: (v: number) => number | string;
}

/**
 * useCountUp — scroll-triggered numeric count-up via motion.animate.
 * Returns [ref, displayValue]. Attach ref to the element whose inView
 * triggers the count; read displayValue as the rendered number.
 */
export function useCountUp(
  target: number,
  { duration = 1.4, delay = 0, format = (v) => Math.round(v) }: CountUpOpts = {},
): [React.RefObject<HTMLDivElement | null>, number | string] {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, HUD_VIEWPORT);
  const reduced = useReducedMotion();
  const [value, setValue] = useState<number>(reduced ? target : 0);

  useEffect(() => {
    if (!inView) return;
    if (reduced) {
      setValue(target);
      return;
    }
    const controls = animateValue(0, target, {
      duration,
      delay,
      ease: [0.33, 1, 0.68, 1],
      onUpdate: (v: number) => setValue(v),
    });
    return () => controls.stop();
  }, [inView, reduced, target, duration, delay]);

  return [ref, format(value)];
}
