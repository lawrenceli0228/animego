"use client";

// The language control.
//
// It used to be a two-state flip — "EN" / "中", "切换到中文" — sitting on top
// of nextLocale(), which has always been an N-way cycle over LOCALES. At two
// locales the label happened to describe what the button did. At three it
// stops: a reader on a Traditional page is invited to "switch to Chinese"
// while already reading Chinese, and the third locale is reachable only by
// pressing twice with no way to know that.
//
// So the options are derived from LOCALES and each names itself. Adding a
// fourth locale is one line in LOCALE_LABEL and nothing here.
//
// Two constraints this file is shaped around, both learned the hard way:
//
//   useSearchParams() is not used, and must not be. This renders inside the
//   root layout; an unwrapped useSearchParams() anywhere in that tree bails
//   every route out to client-side rendering, which silently un-prerenders
//   /anime/[id] and with it the only thing the Cloudflare edge cache holds.
//   The query is read off `window.location` inside the click handler, which
//   never runs during render or on the server.
//
//   useRouter() is not used either. It throws "invariant expected app router
//   to be mounted" with no router context, and the navbar is exercised by
//   bare renderToString tests. usePathname() merely returns null there, so
//   every read of it is `?? "/"`.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useLang } from "@/lib/lang-client";
import {
  LOCALES,
  LOCALE_LABEL,
  splitLocale,
  type Locale,
} from "@/lib/i18n/locale";
import "./language-menu.css";

/** The locale the current URL addresses; the default when there is no path. */
function useCurrentLocale(): Locale {
  return splitLocale(usePathname() ?? "/").locale;
}

interface OptionListProps {
  /** Sets `role` on each option — "menuitem" inside a menu, "option" else. */
  role: "menuitem" | "option";
  current: Locale;
  onPick: (locale: Locale) => void;
  /** Registers each option for roving arrow-key focus. Optional. */
  registerRef?: (index: number, el: HTMLButtonElement | null) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  labelledBy?: string;
}

/**
 * The options themselves, shared by both surfaces so there is one row markup
 * and one source of truth for what "current" looks like.
 *
 * The current row is marked twice on purpose: `aria-current` for assistive
 * technology, and a check glyph plus a lit background for everyone else. One
 * without the other is half a control.
 */
function LocaleOptionList({
  role,
  current,
  onPick,
  registerRef,
  onKeyDown,
  labelledBy,
}: OptionListProps) {
  return (
    <div
      className="agc-lang-list"
      role={role === "menuitem" ? "group" : "listbox"}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
    >
      {LOCALES.map((locale, index) => {
        const isCurrent = locale === current;
        return (
          <button
            key={locale}
            type="button"
            ref={(el) => registerRef?.(index, el)}
            role={role}
            className={`agc-lang-option${isCurrent ? " is-current" : ""}`}
            // aria-current, not aria-disabled: the row stays operable so a
            // reader who lands on it by keyboard is not trapped on a dead
            // control, and re-picking the current locale is a harmless
            // same-URL navigation.
            aria-current={isCurrent ? "true" : undefined}
            // The endonym is the whole accessible name and it is already in
            // the target language, so no aria-label overrides it — a screen
            // reader announcing "English" in an English voice is exactly what
            // an English-seeking reader is listening for.
            lang={locale}
            onClick={() => onPick(locale)}
          >
            <span className="agc-lang-check" aria-hidden="true">
              {isCurrent ? "✓" : ""}
            </span>
            {LOCALE_LABEL[locale].endonym}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Arrow-key handling for a vertical option list, plus Home/End.
 *
 * Native buttons keep Tab, Enter and Space working for free; this adds the
 * movement a menu is expected to have on top of that.
 */
function useRovingFocus(count: number, enabled: boolean) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const registerRef = useCallback((index: number, el: HTMLButtonElement | null) => {
    refs.current[index] = el;
  }, []);

  const focusAt = useCallback((index: number) => {
    const wrapped = ((index % count) + count) % count;
    refs.current[wrapped]?.focus();
  }, [count]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const at = refs.current.findIndex((el) => el === document.activeElement);
      if (at === -1) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusAt(at + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusAt(at - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusAt(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusAt(count - 1);
      }
    },
    [count, enabled, focusAt],
  );

  return { registerRef, onKeyDown, focusAt };
}

/**
 * The options rendered flat, for use inside a dropdown that is already a
 * `role="menu"` — the account menu. A popup inside a popup would be a worse
 * control and a lot more code; the list is three rows.
 */
export function LanguageMenuInline({ onPicked }: { onPicked?: () => void }) {
  const { t, switchTo } = useLang();
  const current = useCurrentLocale();
  const { registerRef, onKeyDown } = useRovingFocus(LOCALES.length, true);

  return (
    <div className="agc-lang-inline">
      <p className="agc-lang-inline-label" id="agc-lang-inline-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>
        {t("nav.language")}
      </p>
      <LocaleOptionList
        role="menuitem"
        current={current}
        labelledBy="agc-lang-inline-label"
        registerRef={registerRef}
        onKeyDown={onKeyDown}
        onPick={(locale) => {
          onPicked?.();
          switchTo(locale);
        }}
      />
    </div>
  );
}

/**
 * A trigger plus its own popup, for the logged-out navbar where there is no
 * account menu to live inside.
 */
export function LanguageMenu() {
  const { t, switchTo } = useLang();
  const current = useCurrentLocale();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { registerRef, onKeyDown, focusAt } = useRovingFocus(LOCALES.length, open);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Same dismissal contract as AvatarMenu: pointer outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Opening moves focus onto the current option, so a keyboard user lands on
  // the list rather than having to Tab into it past the trigger.
  useEffect(() => {
    if (!open) return;
    const at = LOCALES.indexOf(current);
    focusAt(at === -1 ? 0 : at);
  }, [open, current, focusAt]);

  return (
    <div className="agc-lang-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="agc-lang-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.language")}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>
        <span aria-hidden="true">{LOCALE_LABEL[current].short}</span>
      </button>

      {open && (
        <div className="agc-lang-pop" role="menu" aria-label={t("nav.language")}>
          <LocaleOptionList
            role="menuitem"
            current={current}
            registerRef={registerRef}
            onKeyDown={onKeyDown}
            onPick={(locale) => {
              setOpen(false);
              switchTo(locale);
            }}
          />
        </div>
      )}
    </div>
  );
}
