"use client";

// The header's search: a magnifier at the right of the bar that opens
// leftwards into a field. Enter goes to /search?q=…; Escape folds it back and
// returns focus to the magnifier. On a phone the magnifier is simply a link to
// /search, whose page has the full search box.
//
// The field is only rendered while the box is open. Two reasons:
//
//   - /search has its own `form[role=search]` with `input[name=q]`, and both
//     the page and its tests address them by those selectors. A second,
//     permanent copy in the header on every page would make each of them
//     ambiguous.
//   - Nothing here needs the pre-hydration fallback the search page carries: a
//     closed box has no field to type into, and an open one is opened by
//     React.
//
// Input methods. Chinese and Japanese readers press Enter to confirm a
// candidate, and that Enter must not search for half-typed pinyin or kana. The
// submit is ignored while a composition is open and when the keystroke that
// triggered it belonged to the IME (lib/nav/navSearch → isImeKeystroke covers
// Safari, which ends the composition before the keydown arrives).

import Link from "@/components/ui/LocaleLink";
import { useLocaleRouter } from "@/components/ui/LocaleLink";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLang } from "@/lib/lang-client";
import { isImeKeystroke, navSearchPath } from "@/lib/nav/navSearch";
import styles from "./NavSearch.module.css";

interface NavSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SearchIcon({ size }: { size: number }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

export default function NavSearch({ open, onOpenChange }: NavSearchProps) {
  const { t } = useLang();
  const router = useLocaleRouter();
  const [value, setValue] = useState("");
  const fieldId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const imeKeyRef = useRef(false);

  // Both focus moves below pass preventScroll: the bar is sticky, so the
  // control is already on screen, and letting the browser "reveal" it moved
  // the page instead (Navbar.module.css has the whole story).
  const close = (restoreFocus: boolean) => {
    onOpenChange(false);
    setValue("");
    composingRef.current = false;
    imeKeyRef.current = false;
    if (restoreFocus) toggleRef.current?.focus({ preventScroll: true });
  };

  // The field appears on open; give it the caret once it exists.
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // A pointer-down anywhere else folds it away.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        onOpenChange(false);
        setValue("");
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    imeKeyRef.current = isImeKeystroke(event.nativeEvent);
    if (event.key === "Escape" && !imeKeyRef.current) {
      event.preventDefault();
      close(true);
    }
  };

  const go = () => {
    const href = navSearchPath(value);
    close(false);
    router.push(href);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current || imeKeyRef.current) {
      imeKeyRef.current = false;
      return;
    }
    go();
  };

  // Closed: open it. Open with words in it: the magnifier is the search
  // button people expect it to be. Open and empty: fold it away.
  const onToggle = () => {
    if (!open) onOpenChange(true);
    else if (value.trim() !== "") go();
    else close(false);
  };

  return (
    <>
      <div ref={wrapRef} className={styles.desktop}>
        <div className={styles.pill} data-open={open}>
          <button
            ref={toggleRef}
            type="button"
            className={styles.toggle}
            aria-label={t("nav.searchAnime")}
            aria-expanded={open}
            aria-controls={open ? fieldId : undefined}
            onClick={onToggle}
          >
            <SearchIcon size={18} />
          </button>
          {open ? (
            <form
              className={styles.form}
              role="search"
              aria-label={t("nav.searchAnime")}
              onSubmit={onSubmit}
              onBlur={(event) => {
                // Tabbing away from an empty box folds it; a box with words in
                // it stays, so a stray Tab does not throw away what was typed.
                const next = event.relatedTarget as Node | null;
                if (value.trim() === "" && !(next && wrapRef.current?.contains(next))) {
                  onOpenChange(false);
                }
              }}
            >
              <input
                ref={inputRef}
                id={fieldId}
                className={styles.input}
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                aria-label={t("nav.searchAnime")}
                placeholder={t("nav.searchPlaceholder")}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={onKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
              />
            </form>
          ) : null}
        </div>
      </div>

      <Link
        href="/search"
        prefetch={false}
        className={styles.phone}
        aria-label={t("nav.searchAnime")}
      >
        <SearchIcon size={22} />
      </Link>
    </>
  );
}
