"use client";

// Outline button that opens the TorrentModal. Pulled out of
// DetailActions so the modal trigger has its own hover state without
// re-rendering the rest of the row.
//
// The hover and focus state it used to hold — two useState hooks and four
// handlers driving an inline style object — is now the `outline` variant of
// components/ui/Button. Identical to what ShareButton held, character for
// character, which is why both moved at once.

import Button from "@/components/ui/Button";

interface MagnetButtonProps {
  onOpen: () => void;
  label: string;
}

export default function MagnetButton({ onOpen, label }: MagnetButtonProps) {
  return (
    <Button variant="outline" onClick={onOpen}>
      {label}
    </Button>
  );
}
