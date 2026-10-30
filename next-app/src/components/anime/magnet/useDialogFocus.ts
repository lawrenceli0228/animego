"use client";

// Focus for a modal panel: in on open, held inside by Tab, Escape closes,
// and back to what opened it on close — however it closes.

import { useEffect, useRef, type RefObject } from "react";
import { FOCUSABLE_SELECTOR, trapFocusIndex } from "@/lib/nav/focusTrap";

function isShown(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/**
 * @param panelRef      the dialog; it takes focus itself on open (tabIndex -1)
 * @param onClose       called on Escape
 * @param fallbackFocus where focus returns when what held it on open is gone
 *                      or was nothing — Safari does not focus a button it
 *                      clicks, so "what held focus" is often <body>
 */
export function useDialogFocus(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  fallbackFocus?: RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // Read once, on the first run: development runs effects twice, and by the
  // second run the panel itself holds focus.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (openerRef.current === null) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    const panel = panelRef.current;
    const fallback = fallbackFocus?.current ?? null;
    panel?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      // 229: WebKit reports the key that ends an IME composition with
      // isComposing false, so Escape that cancels a pinyin candidate would
      // otherwise close the panel.
      if (!panel || e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Every Tab is placed by hand, not only the two that wrap: Safari by
      // default skips buttons, so from the search box its own next stop is
      // outside the panel — the address bar or a field on the page behind.
      const controls = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isShown);
      if (controls.length === 0) return;
      const at = document.activeElement instanceof HTMLElement ? controls.indexOf(document.activeElement) : -1;
      const wrap = trapFocusIndex(controls.length, at, e.shiftKey);
      const next = wrap ?? at + (e.shiftKey ? -1 : 1);
      e.preventDefault();
      controls[next].focus();
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      // A frame later, once the panel has left the DOM. If it has not, this
      // was development re-running the effect, and the panel keeps focus.
      window.requestAnimationFrame(() => {
        if (panel?.isConnected) return;
        const opener = openerRef.current;
        const target = opener?.isConnected ? opener : fallback;
        target?.focus({ preventScroll: true });
      });
    };
  }, [panelRef, fallbackFocus]);
}
