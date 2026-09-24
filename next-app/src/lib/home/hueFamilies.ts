// "按色调逛" — the season grouped by the colour of each cover.
//
// Seven families over the OKLCH hue circle, half-open [lo, hi). Red wraps
// through 0°. The boundaries are the approved design's, and they are uneven on
// purpose: OKLCH spends more of its circle on blues and purples than on
// yellows, so equal slices would put most covers in two families.
//
// An anime with no hue (the brand-fallback accent, or a grey cover) belongs to
// no family. Counting the fallback violet as purple would put unrelated shows
// side by side under a colour none of them has.
//
// Pure: no DOM, no React.

export type HueFamilyKey = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple";

export interface HueFamily {
  key: HueFamilyKey;
  /** Inclusive lower bound, degrees. */
  lo: number;
  /** Exclusive upper bound, degrees. Below `lo` when the range wraps 0°. */
  hi: number;
  /** A representative angle, for the family's colour dot. */
  hue: number;
}

export const HUE_FAMILIES: readonly HueFamily[] = [
  { key: "red", lo: 345, hi: 35, hue: 20 },
  { key: "orange", lo: 35, hi: 75, hue: 55 },
  { key: "yellow", lo: 75, hi: 115, hue: 95 },
  { key: "green", lo: 115, hi: 165, hue: 145 },
  { key: "cyan", lo: 165, hi: 215, hue: 195 },
  { key: "blue", lo: 215, hi: 275, hue: 245 },
  { key: "purple", lo: 275, hi: 345, hue: 305 },
];

function inFamily(family: HueFamily, hue: number): boolean {
  return family.lo > family.hi
    ? hue >= family.lo || hue < family.hi
    : hue >= family.lo && hue < family.hi;
}

export function hueFamilyOf(hue: number | null): HueFamilyKey | null {
  if (hue === null || !Number.isFinite(hue)) return null;
  const normalised = ((hue % 360) + 360) % 360;
  return HUE_FAMILIES.find((f) => inFamily(f, normalised))?.key ?? null;
}

export interface HueGroup<T> {
  key: HueFamilyKey;
  hue: number;
  items: T[];
}

/**
 * Families in circle order, each holding its items in their original order.
 * Families with nothing in them are omitted — a pill that opens an empty
 * panel is a control that does nothing.
 */
export function groupByHueFamily<T extends { hue: number | null }>(items: readonly T[]): HueGroup<T>[] {
  const buckets = new Map<HueFamilyKey, T[]>();
  for (const item of items) {
    const key = hueFamilyOf(item.hue);
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  return HUE_FAMILIES.filter((f) => buckets.has(f.key)).map((f) => ({
    key: f.key,
    hue: f.hue,
    items: buckets.get(f.key) ?? [],
  }));
}

/** The family shown first: the largest, ties going to circle order. */
export function defaultFamily(groups: ReadonlyArray<{ key: HueFamilyKey; items: readonly unknown[] }>): HueFamilyKey | null {
  let best: { key: HueFamilyKey; size: number } | null = null;
  for (const g of groups) {
    if (!best || g.items.length > best.size) best = { key: g.key, size: g.items.length };
  }
  return best?.key ?? null;
}
