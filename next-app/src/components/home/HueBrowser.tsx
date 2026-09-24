"use client";

// 按色调逛 — the season grouped by the colour of each cover, one family at a
// time so the section never turns into a wall of posters.
//
// Families come pre-built from the server (lib/home/hueFamilies.ts), labels
// included, so this component translates nothing through an indirect key.
// Only the choice of family is client state. Every panel stays mounted and a
// switch is a staggered crossfade, like the hero's.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { useState, type CSSProperties } from "react";
import type { HueFamilyKey } from "@/lib/home/hueFamilies";
import { cardToneVars, toneLadder } from "@/lib/home/tone";
import type { HueCard } from "@/lib/home/viewModels";
import SectionHeader from "./SectionHeader";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./HueBrowser.module.css";

export interface HueFamilyView {
  key: HueFamilyKey;
  label: string;
  /** The family's representative angle, for its dot and its selected pill. */
  hue: number;
  /** Everything in the family — the pill's number. `items` may be capped. */
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
}

type Vars = CSSProperties & Record<`--${string}`, string>;

export default function HueBrowser({ title, note, groupLabel, countTemplate, families, defaultKey }: HueBrowserProps) {
  const [selected, setSelected] = useState<HueFamilyKey>(defaultKey);
  if (families.length === 0) return null;

  return (
    <section className={section.bleed} aria-labelledby="home-hue">
      <SectionHeader id="home-hue" title={title} note={note} />
      <div className={styles.pills} role="group" aria-label={groupLabel}>
        {families.map((f) => {
          const tone = toneLadder(f.hue);
          const vars: Vars = { "--pill-tone": tone.text, "--pill-fill": tone.fill, "--pill-line": tone.line };
          return (
            <button
              key={f.key}
              type="button"
              className={styles.pill}
              style={vars}
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
          const on = f.key === selected;
          return (
            <div
              key={f.key}
              className={styles.panel}
              data-active={on}
              aria-hidden={!on}
              inert={!on}
            >
              {f.items.map((it, k) => {
                const vars = {
                  ...(cardToneVars(it.hue) as unknown as Vars),
                  "--stagger": `${60 + k * 60}ms`,
                } as Vars;
                return (
                  <Link key={it.id} href={it.href} prefetch={false} className={`${cards.card} ${styles.card}`} style={vars}>
                    <div className={`${cards.cover} ${styles.cover}`}>
                      <span className={cards.zoom}>
                        <FadeImage src={it.cover} alt="" width={200} height={267} className={cards.img} />
                      </span>
                      <span className={styles.band} aria-hidden />
                    </div>
                    <div className={styles.body}>
                      <span className={`${cards.title} ${cards.clamp2} ${styles.title}`}>{it.title}</span>
                      <span className={cards.meta}>
                        {it.score ? <span className={cards.score}>{it.score}</span> : null}
                        <span className={cards.clamp1}>{it.meta}</span>
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
