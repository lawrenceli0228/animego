/**
 * Shared types for the poster-accent system (cache + sampler + HeroAccent).
 * Kept tiny so both server and client modules can import without pulling
 * canvas/localStorage code into their bundles.
 */

export type AccentSource = "server" | "client";

export interface CachedAccent {
  accent: string;
  rgb: string;
  source: AccentSource;
}

export interface SampledAccent {
  accent: string;
  accentRgb: string;
}
