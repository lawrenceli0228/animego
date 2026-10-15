"use client";

// 按色调逛 — the season grouped by the colour of each cover, one family at a
// time so the section never turns into a wall of posters.
//
// Families come pre-built from the server (lib/home/hueFamilies.ts), labels
// included, so this component translates nothing through an indirect key.
// Only the choice of family is client state. Every family is a sideways rail
// holding all of its shows (HueRail.tsx); every panel stays mounted and a
// switch is a staggered crossfade, like the hero's. A rail ends by offering
// the next family.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { nextFamily, type HueFamilyKey } from "@/lib/home/hueFamilies";
import { toneLadder } from "@/lib/home/tone";
import type { HueCard } from "@/lib/home/viewModels";
import HueRail, { type HueRailCopy } from "./HueRail";
import SectionHeader from "./SectionHeader";
import section from "./section.module.css";
import styles from "./HueBrowser.module.css";

export interface HueFamilyView {
  key: HueFamilyKey;
  label: string;
  /** The family's representative angle, for its dot and its selected pill. */
  hue: number;
  /** Everything in the family — the pill's number, and the length of `items`. */
  count: number;
  items: HueCard[];
}

interface HueBrowserProps {
  title: string;
  note: string;
  groupLabel: string;
  /** "{{n}} 部" */
  countTemplate: string;
  families: HueFamilyView[];
  defaultKey: HueFamilyKey;
  railCopy: HueRailCopy;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/**
 * On a phone the pills scroll sideways and a pill can sit off-screen. Bring it
 * into the row's view — by scrolling the row itself, never scrollIntoView,
 * which would move the page.
 */
function revealPill(row: HTMLElement, pill: HTMLElement) {
  if (row.scrollWidth <= row.clientWidth) return;
  const start = pill.offsetLeft;
  const end = start + pill.offsetWidth;
  if (start >= row.scrollLeft && end <= row.scrollLeft + row.clientWidth) return;
  row.scrollLeft = start - 20;
}

export default function HueBrowser({
  title,
  note,
  groupLabel,
  countTemplate,
  families,
  defaultKey,
  railCopy,
}: HueBrowserProps) {
  const [selected, setSelected] = useState<HueFamilyKey>(defaultKey);
  const pillsRef = useRef<HTMLDivElement | null>(null);

  const pillOf = (key: HueFamilyKey) =>
    pillsRef.current?.querySelector<HTMLElement>(`[data-family="${key}"]`) ?? null;

  // The default (largest) family can start off-screen in the phone's pill row.
  useEffect(() => {
    const row = pillsRef.current;
    const pill = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && pill) revealPill(row, pill);
  }, []);

  // The end of a rail moves on to the next family. The button that was
  // pressed goes inert with its panel, so focus goes to the new family's pill
  // rather than falling back to the page.
  const goTo = (key: HueFamilyKey) => {
    setSelected(key);
    const row = pillsRef.current;
    const pill = pillOf(key);
    if (!row || !pill) return;
    revealPill(row, pill);
    pill.focus({ preventScroll: true });
  };

  if (families.length === 0) return null;

  const byKey = new Map(families.map((f) => [f.key, f]));

  return (
    <section className={section.bleed} aria-labelledby="home-hue">
      <SectionHeader id="home-hue" title={title} note={note} />
      <div ref={pillsRef} className={styles.pills} role="group" aria-label={groupLabel}>
        {families.map((f) => {
          const tone = toneLadder(f.hue);
          const vars: Vars = { "--pill-tone": tone.text, "--pill-fill": tone.fill, "--pill-line": tone.line };
          return (
            <button
              key={f.key}
              type="button"
              className={styles.pill}
              style={vars}
              data-family={f.key}
              aria-pressed={f.key === selected}
              onClick={() => setSelected(f.key)}
            >
              <span className={styles.dot} aria-hidden />
              {f.label}
              <span className={styles.count}>{countTemplate.split("{{n}}").join(String(f.count))}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.stage}>
        {families.map((f) => {
          const nextKey = nextFamily(families, f.key);
          const next = nextKey ? (byKey.get(nextKey) ?? null) : null;
          return (
            <HueRail
              key={f.key}
              family={f}
              active={f.key === selected}
              next={next}
              onNext={() => {
                if (nextKey) goTo(nextKey);
              }}
              copy={railCopy}
            />
          );
        })}
      </div>
    </section>
  );
}
