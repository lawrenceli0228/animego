"use client";

// 按色调 — seven dots, one per hue family the season has covers in. A dot
// opens into "蓝调 26" under the pointer (and when chosen); choosing one
// filters to that family and tints the page.

import type { HueFamilyKey } from "@/lib/home/hueFamilies";
import { oklchCss } from "@/lib/home/tone";
import { fillTemplate } from "@/lib/home/time";
import type { HueOption } from "@/lib/seasonal/browse";
import type { BrowseCopy } from "./useBrowseCopy";
import tags from "./tags.module.css";

interface HueDotsProps {
  options: readonly HueOption[];
  selected: HueFamilyKey | "";
  onPick: (key: HueFamilyKey) => void;
  copy: BrowseCopy;
  /** The phone's own scrolling row rather than the desktop tag row's cluster. */
  phone?: boolean;
}

export default function HueDots({ options, selected, onPick, copy, phone = false }: HueDotsProps) {
  if (options.length === 0) return null;
  return (
    <div className={phone ? tags.hueRow : tags.hues} role="group" aria-label={copy.hueGroup} data-hues={phone ? "phone" : "desktop"}>
      {options.map((o) => {
        const name = copy.hueFamily[o.key];
        return (
          <button
            key={o.key}
            type="button"
            className={tags.hue}
            aria-pressed={selected === o.key}
            aria-label={fillTemplate(copy.hueDot, { family: name, n: o.count })}
            data-hue={o.key}
            onClick={() => onPick(o.key)}
          >
            <i className={tags.hueDot} style={{ background: oklchCss(72, 0.13, o.hue) }} />
            <span className={tags.hueName}>{name}</span>
            <em className={tags.hueCount}>{o.count}</em>
          </button>
        );
      })}
    </div>
  );
}
