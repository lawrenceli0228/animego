"use client";

// One family of 按色调逛 as a sideways rail: every show in the family, at the
// homepage's card size, then a panel naming the next family. Under the row, the
// same slider as 今日更新's, in the family's own colour.
//
// The rail is 今日更新's (useRail.ts): touch scrolls it natively, a mouse drags
// it (a quick drag flings on and comes to rest on a card), and the slider is
// dragged, its track clicked, or the range input behind it used from the
// keyboard. Each family keeps its own rail, so a reader who goes to another
// colour and back finds the row where they left it.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { useRef, type CSSProperties } from "react";
import { fillTemplate } from "@/lib/home/time";
import { cardToneVars, toneLadder } from "@/lib/home/tone";
import type { HueCard } from "@/lib/home/viewModels";
import type { HueFamilyView } from "./HueBrowser";
import { ChevronIcon } from "./icons";
import { useRailDrag, useRailMotion, useRailSlider } from "./useRail";
import cards from "./cards.module.css";
import railSlider from "./railSlider.module.css";
import styles from "./HueBrowser.module.css";

/** The section's words, already in the page's language ({{family}}, {{n}}, … filled here). */
export interface HueRailCopy {
  /** The range input's name: "横向滚动{{family}}". */
  scroll: string;
  /** What the range input says: "第 {{from}}–{{to}} 部，共 {{n}} 部". */
  scrollValue: string;
  /** "{{family}}就这些". */
  endTitle: string;
  /** "下一组 · {{family}} {{n}} 部". */
  endNext: string;
  /** "看{{family}}". */
  endLink: string;
}

interface HueRailProps {
  family: HueFamilyView;
  /** The family on show; the others stay mounted, hidden and inert, for the crossfade. */
  active: boolean;
  /** This family has been on show: its covers may load. Until then each card keeps its tone fill. */
  loadCovers: boolean;
  /** Where the end of the row sends the reader; null when there is no other family. */
  next: HueFamilyView | null;
  onNext: () => void;
  copy: HueRailCopy;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/** The cards that rise one after another when a family comes on; the rest rise with the last of them. */
const STAGGERED = 8;

export function hueRailId(family: HueFamilyView): string {
  return `home-hue-${family.key}`;
}

export default function HueRail({ family, active, loadCovers, next, onNext, copy }: HueRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const motion = useRailMotion(railRef);
  const drag = useRailDrag({ onPress: motion.stop, onRelease: motion.fling });
  const slider = useRailSlider(railRef, { thumbRef, inputRef }, motion, (first, last, total) =>
    fillTemplate(copy.scrollValue, { from: first, to: last, n: total }),
  );

  // Moved by hand or flung: no snapping against it, no hover lift on the
  // cards passing under the pointer.
  const moving = drag.dragging || slider.dragging || motion.flinging;
  const tone = toneLadder(family.hue);
  const panelVars: Vars = { "--slider-line": tone.line, "--slider-tone": tone.text };
  const railId = hueRailId(family);

  return (
    <div className={styles.panel} style={panelVars} data-active={active} aria-hidden={!active} inert={!active}>
      <div
        ref={railRef}
        id={railId}
        className={styles.rail}
        data-dragging={drag.dragging ? "true" : undefined}
        data-moving={moving ? "true" : undefined}
        {...drag.handlers}
      >
        {family.items.map((it, k) => (
          <HueRailCard key={it.id} item={it} order={k} loadCover={loadCovers} />
        ))}
        {next ? (
          <div className={styles.end}>
            <span className={styles.endTitle}>{fillTemplate(copy.endTitle, { family: family.label })}</span>
            <span className={styles.endNext}>
              {fillTemplate(copy.endNext, { family: next.label, n: next.count })}
            </span>
            <button
              type="button"
              className={styles.endLink}
              style={{ color: toneLadder(next.hue).text }}
              onClick={onNext}
            >
              {fillTemplate(copy.endLink, { family: next.label })}
              <ChevronIcon size={14} />
            </button>
          </div>
        ) : null}
      </div>
      {/* The keyboard's and assistive technology's way along the row; the
          slider after it is its picture and the pointer's. Kept in step with
          the rail by useRailSlider. */}
      <input
        ref={inputRef}
        type="range"
        className={railSlider.scrub}
        aria-label={fillTemplate(copy.scroll, { family: family.label })}
        aria-controls={railId}
        min={0}
        step={1}
        defaultValue={0}
        disabled={!slider.overflow}
        {...slider.inputHandlers}
      />
      <div
        className={railSlider.slider}
        data-overflow={slider.overflow ? "true" : "false"}
        data-active={slider.active ? "true" : undefined}
        data-dragging={slider.dragging ? "true" : undefined}
        aria-hidden
        {...slider.sliderHandlers}
      >
        <span className={railSlider.track} />
        <span ref={thumbRef} className={railSlider.thumb} />
      </div>
    </div>
  );
}

function HueRailCard({ item: it, order, loadCover }: { item: HueCard; order: number; loadCover: boolean }) {
  const vars = {
    ...(cardToneVars(it.hue) as unknown as Vars),
    "--stagger": `${60 + Math.min(order, STAGGERED - 1) * 60}ms`,
  } as Vars;
  return (
    <Link href={it.href} prefetch={false} className={`${cards.card} ${styles.card}`} style={vars} data-card>
      <div className={`${cards.cover} ${styles.cover}`}>
        <span className={`${cards.zoom} ${styles.zoom}`}>
          <FadeImage src={loadCover ? it.cover : null} alt="" width={200} height={267} className={cards.img} />
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
}
