"use client";

// A labelled dropdown: the label above, a 40px trigger showing the current
// value, and whatever menu the caller puts under it.
//
// Which menu is open is the parent's state (one at a time). This component
// only reports presses. Escape is handled here, on the field itself — the
// trigger and its menu both live inside it, so Escape from either closes the
// menu and gives focus back to the trigger. Nothing listens on the document
// for keys. Outside clicks are the parent's: it knows which field is open.

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronIcon } from "./icons";
import controls from "./controls.module.css";

export type MenuKey = "genre" | "year" | "season" | "format" | "more" | "sort";

interface MenuFieldProps {
  menuKey: MenuKey;
  label: string;
  value: string;
  /** The value differs from "any": the trigger reads in the accent colour. */
  isSet: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** listbox for options that set state, true for menus of links. */
  popup: "listbox" | "true";
  children: (ids: { labelId: string }) => ReactNode;
}

export default function MenuField({ menuKey, label, value, isSet, open, onToggle, onClose, popup, children }: MenuFieldProps) {
  const labelId = useId();
  const valueId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    onClose();
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className={controls.field} data-menu={menuKey} data-field={menuKey} onKeyDown={onKeyDown}>
      <span className={controls.label} id={labelId}>
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={controls.control}
        aria-haspopup={popup}
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        data-set={isSet ? "true" : undefined}
        onClick={onToggle}
      >
        <span className={controls.value} id={valueId}>
          {value}
        </span>
        <ChevronIcon className={controls.chev} />
      </button>
      {children({ labelId })}
    </div>
  );
}
