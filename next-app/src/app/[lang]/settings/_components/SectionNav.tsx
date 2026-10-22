"use client";

import { SETTINGS_SECTIONS, type SettingsSection } from "./sectionSpy";

interface SectionNavProps {
  /** "toc": the desktop index under the pass. "chips": the phone's sticky row. */
  variant: "toc" | "chips";
  label: string;
  labels: Record<SettingsSection, string>;
  current: SettingsSection;
  /** Shown beside 登录设备; left off when there are none to count. */
  deviceCount: number;
  onSelect: (id: SettingsSection) => void;
}

/**
 * The page's section index. Plain #anchors, so the jump is the browser's own
 * (html's scroll-padding-top keeps the target clear of the site header) and
 * a section can be linked to; the click only tells the scroll-spy which one
 * was asked for.
 */
export default function SectionNav({ variant, label, labels, current, deviceCount, onSelect }: SectionNavProps) {
  const isToc = variant === "toc";
  return (
    <nav className={isToc ? "set-toc" : "set-chips"} aria-label={label}>
      {SETTINGS_SECTIONS.map((id) => {
        const counted = id === "devices" && deviceCount > 0;
        return (
          <a
            key={id}
            className={isToc ? "set-toc-link" : "set-chip"}
            href={`#${id}`}
            aria-current={current === id ? "true" : undefined}
            onClick={() => onSelect(id)}
          >
            {isToc ? labels[id] : counted ? `${labels[id]} ${deviceCount}` : labels[id]}
            {isToc && counted && <span className="set-toc-count">{deviceCount}</span>}
          </a>
        );
      })}
    </nav>
  );
}
