"use client";

// Outline button that opens the magnet panel. Pulled out of
// DetailActions so the modal trigger has its own hover state without
// re-rendering the rest of the row.
//
// The hover and focus state it used to hold — two useState hooks and four
// handlers driving an inline style object — is now the `outline` variant of
// components/ui/Button. Identical to what ShareButton held, character for
// character, which is why both moved at once.

import type { Ref } from "react";
import Button from "@/components/ui/Button";

interface MagnetButtonProps {
  onOpen: () => void;
  label: string;
  /** Where the panel returns focus when it closes (React 19 passes `ref` as a prop). */
  ref?: Ref<HTMLButtonElement>;
  /** Whether the panel it opens is open. */
  expanded?: boolean;
}

export default function MagnetButton({ onOpen, label, ref, expanded = false }: MagnetButtonProps) {
  return (
    <Button ref={ref} variant="outline" onClick={onOpen} aria-haspopup="dialog" aria-expanded={expanded}>
      {label}
    </Button>
  );
}
