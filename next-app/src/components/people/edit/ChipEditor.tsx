"use client";

// A row of chips with a remove control each and an add button: a
// character's aliases (the canvas's .alias / .ed-add) or a person's
// occupations (the tone tags). The add button becomes a field; Enter or
// leaving it adds what was typed, Escape drops it.

import { useState, type KeyboardEvent } from "react";
import type { Chip } from "@/lib/people/edit/model";
import { fillTemplate } from "@/lib/people/template";
import e from "./edit.module.css";

interface ChipEditorProps {
  chips: Chip[];
  onChange: (chips: Chip[]) => void;
  variant: "alias" | "tag";
  /** Shown before the chips on a desktop (别名); hidden on a phone. */
  label?: string;
  addLabel: string;
  /** The add button on a phone, where the label is not shown (+ 别名). */
  addLabelPhone: string;
  inputLabel: string;
  /** "移除别名 {{name}}" */
  removeTemplate: string;
  maxLength: number;
  maxCount: number;
}

export default function ChipEditor({
  chips,
  onChange,
  variant,
  label,
  addLabel,
  addLabelPhone,
  inputLabel,
  removeTemplate,
  maxLength,
  maxCount,
}: ChipEditorProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");

  const commit = () => {
    const value = text.trim();
    setAdding(false);
    setText("");
    if (!value || chips.some((c) => c.value === value)) return;
    onChange([...chips, { value, label: value }]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setAdding(false);
      setText("");
    }
  };

  return (
    <div className={e.chipRow}>
      {label ? <span className={e.chipLabel}>{label}</span> : null}
      {chips.map((chip) => (
        <span key={chip.value} className={variant === "tag" ? e.tag : e.alias}>
          {chip.label}
          <button
            type="button"
            className={e.chipX}
            aria-label={fillTemplate(removeTemplate, { name: chip.label })}
            onClick={() => onChange(chips.filter((c) => c.value !== chip.value))}
          >
            <svg className={e.icon} viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      ))}
      {adding ? (
        <input
          // The field the reader just asked for, by pressing the button it replaced.
          autoFocus
          className={e.chipInput}
          aria-label={inputLabel}
          value={text}
          maxLength={maxLength}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      ) : chips.length < maxCount ? (
        <button type="button" className={e.addChip} onClick={() => setAdding(true)}>
          <span className={e.desktopOnly}>{addLabel}</span>
          <span className={e.mobileOnly}>{addLabelPhone}</span>
        </button>
      ) : null}
    </div>
  );
}
