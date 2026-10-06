"use client";

// 分类 — the header's genre menu, after AniList's browse dropdown.
//
// There is no genre index page; this panel IS the index. It lists every
// browsable genre hub (lib/nav/navLinks → genreNavItems), labelled in the
// reader's language.
//
// It opens two ways. A mouse resting on it opens it after a short intent delay
// (sweeping across the bar does not flash it) and closes it a moment after the
// pointer leaves. A press — click, Enter, Space — opens it and keeps it open
// until it is pressed again, Escape, a click elsewhere, or focus leaving it.
// Who is allowed to close it is lib/nav/hoverMenu's transition table.
//
// The ARIA pattern is a disclosure, not a `menu`: the panel holds ordinary
// links, Tab walks them, and nothing is hidden from a screen reader behind
// arrow-key-only semantics. Arrow keys work as a convenience on top.
//
// The panel is always in the markup, hidden with `visibility` when closed, so
// it can fade both ways and its links ship in the server HTML — every page
// links every genre hub.

import Link from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useLang } from "@/lib/lang-client";
import {
  CLOSED_MENU,
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  hoverMenu,
} from "@/lib/nav/hoverMenu";
import { genreNavItems, isUnder } from "@/lib/nav/navLinks";
import styles from "./GenreMenu.module.css";

interface GenreMenuProps {
  /** The bar's link class, so the trigger is the same box as its neighbours. */
  triggerClassName: string;
  label: string;
}

export default function GenreMenu({ triggerClassName, label }: GenreMenuProps) {
  const { lang } = useLang();
  const pathname = usePathname() ?? "/";
  const [state, dispatch] = useReducer(hoverMenu, CLOSED_MENU);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);

  const items = genreNavItems(lang);
  const inSection = isUnder(pathname, "/genre");

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // Escape and a pointer-down elsewhere, while open.
  useEffect(() => {
    if (!state.open) return;
    const onDown = (event: globalThis.PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) dispatch("dismiss");
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const hadFocus = wrapRef.current?.contains(document.activeElement) ?? false;
      dispatch("dismiss");
      // Only take focus back if it was in here; an Escape meant for something
      // else on the page must not yank the caret into the header. Without
      // scrolling: the trigger is in the sticky bar, already on screen.
      if (hadFocus) triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [state.open]);

  // Hover only for a real mouse: a touch "hover" is the start of a tap, and
  // opening on it would make the tap's click toggle the panel straight shut.
  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") return;
    clearTimer();
    if (state.open) return;
    timerRef.current = window.setTimeout(() => dispatch("pointer-enter"), HOVER_OPEN_DELAY_MS);
  };

  const onPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") return;
    clearTimer();
    timerRef.current = window.setTimeout(() => dispatch("pointer-leave"), HOVER_CLOSE_DELAY_MS);
  };

  // Tabbing out of the last link closes it; tabbing between links does not.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && wrapRef.current?.contains(next)) return;
    if (state.open && state.by === "press") dispatch("dismiss");
  };

  const linkRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const focusLink = (index: number) => {
    const count = items.length;
    linkRefs.current[((index % count) + count) % count]?.focus();
  };

  // ArrowDown on the trigger opens the panel and lands on the first genre.
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    clearTimer();
    if (!state.open || state.by !== "press") dispatch("press");
    // The panel is already in the DOM; only its visibility changes, and the
    // link becomes focusable on the next frame once that has applied.
    window.requestAnimationFrame(() => focusLink(0));
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = linkRefs.current.findIndex((el) => el === document.activeElement);
    if (at === -1) return;
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step !== 0) {
      event.preventDefault();
      focusLink(at + step);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusLink(event.key === "Home" ? 0 : items.length - 1);
    }
  };

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName} ${styles.trigger}`}
        aria-expanded={state.open}
        aria-controls={panelId}
        data-current={inSection}
        onClick={() => {
          clearTimer();
          dispatch("press");
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
        <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 10l5 5 5-5" />
        </svg>
      </button>

      <div
        id={panelId}
        className={styles.panel}
        data-open={state.open}
        onKeyDown={onPanelKeyDown}
      >
        <ul className={styles.grid}>
          {items.map((item, index) => {
            const current = isUnder(pathname, item.href);
            return (
              <li key={item.genre}>
                <Link
                  ref={(el) => {
                    linkRefs.current[index] = el;
                  }}
                  href={item.href}
                  prefetch={false}
                  className={styles.item}
                  aria-current={current ? "page" : undefined}
                  onClick={() => dispatch("dismiss")}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
