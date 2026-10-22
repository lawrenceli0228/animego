"use client";

import type { ChangeEvent } from "react";

interface SettingSwitchProps {
  /** Prefix for the title's and description's ids, unique on the page. */
  id: string;
  title: string;
  /** Says what the current position means, so it changes with `checked`. */
  description: string;
  checked: boolean;
  /** A save of this setting is out. */
  busy?: boolean;
  onChange: (next: boolean) => void;
}

/**
 * One switch row — the one control for every on/off setting on the page, so
 * two sections cannot drift into two different-looking switches.
 *
 * A real checkbox with role="switch": tab order, Space to toggle and the
 * checked state reach assistive tech for free, and the track drawn after it
 * (settings.css .set-sw) is only what it looks like.
 */
export default function SettingSwitch({ id, title, description, checked, busy = false, onChange }: SettingSwitchProps) {
  return (
    <div className="set-tg" aria-busy={busy || undefined}>
      <div className="set-tg-text">
        <p className="set-tg-title" id={`${id}-title`}>
          {title}
        </p>
        <p className="set-tg-desc" id={`${id}-desc`}>
          {description}
        </p>
      </div>
      <label className="set-sw">
        <input
          type="checkbox"
          role="switch"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-desc`}
          checked={checked}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
        <i aria-hidden="true" />
      </label>
    </div>
  );
}
