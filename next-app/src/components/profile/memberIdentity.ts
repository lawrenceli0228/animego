// memberIdentity.ts — deterministic identity marks for the member pass.
//
// The pass shows a stable member number ("AGC-000142"), a barcode that
// encodes it, and an enrolment date ("SINCE 2021.04"). All are derived
// purely from data the client already has (the user's uuid + createdAt),
// so the pass renders without any extra backend call. When a real member
// sequence lands (Phase 2), only `memberNo` changes.

const MEMBER_PREFIX = "AGC";
const MEMBER_DIGITS = 6;

/** FNV-1a over a string → unsigned 32-bit. Stable across runtimes. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic member number, e.g. "AGC-000142".
 * Derived from the user's uuid so it is stable per member and never
 * collides for the same id. Not a join-order sequence (that needs the
 * backend) — just a stable credential mark.
 */
export function memberNo(userId: string | null | undefined): string {
  const seed = userId && userId.length > 0 ? userId : "anonymous";
  // Keep it in a friendly 6-digit range (1..999999), never 000000.
  const n = (hash32(seed) % 999999) + 1;
  return `${MEMBER_PREFIX}-${String(n).padStart(MEMBER_DIGITS, "0")}`;
}

export interface BarcodeBar {
  /** "" | "w2" | "w3" — module width. */
  width: "" | "w2" | "w3";
  /** true = empty gap module, false = inked bar. */
  gap: boolean;
}

/**
 * 46 deterministic barcode modules seeded from `seed` (the member number).
 * Alternating bar/gap with varied widths — a Code-128-style credential mark,
 * stable per member. Ported from agc-pass barcode() IIFE.
 */
export function barcodeBars(seed: string, count = 46): BarcodeBar[] {
  let s = 0;
  for (const c of seed) s = (s * 131 + c.charCodeAt(0)) & 0x7fffffff;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const widths: BarcodeBar["width"][] = ["", "w2", "w3"];
  const bars: BarcodeBar[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({ width: widths[Math.floor(rnd() * 3)], gap: i % 2 === 1 });
  }
  return bars;
}

const MONTHS = 12;

/** "SINCE 2021.04" from an ISO timestamp. Falls back to "SINCE —" if unparseable. */
export function sinceLabel(createdAt: string | null | undefined): string {
  const d = createdAt ? new Date(createdAt) : null;
  if (!d || Number.isNaN(d.getTime())) return "SINCE —";
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  return `SINCE ${yr}.${mo}`;
}

/**
 * Membership tenure in years, one decimal, e.g. 5.2.
 * Returns null when createdAt is missing/unparseable.
 */
export function tenureYears(createdAt: string | null | undefined): number | null {
  const d = createdAt ? new Date(createdAt) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const months = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 0) return null;
  return Math.round((months / MONTHS) * 10) / 10;
}
