"use client";

// The phone header's ☰ and the drawer it opens.
//
// The drawer is a real modal, because it covers the page: focus moves into it
// and is trapped there (lib/nav/focusTrap), Escape, the dimmed backdrop and
// any navigation close it, and focus goes back to ☰ afterwards. It is portalled
// to <body>: the header is a sticky element that moves with a transform, and
// anything `position: fixed` inside a transformed ancestor is positioned
// against that ancestor rather than the viewport.
//
// The page underneath is locked with lib/scrollLock, which locks <html>.
// `document.body.style.overflow` would be a no-op here — globals.css gives the
// root `overflow-x: hidden`, so the body's overflow no longer reaches the
// viewport, and every modal in this repo that tried it scrolled anyway.
//
// "Any navigation" is two mechanisms. A click on any link inside the drawer
// closes it (one delegated handler covers the nav links, the genres, the
// wordmark and the sign-in links). And a change of path — back/forward, or a
// navigation from somewhere else — closes it during render, the same
// "adjust state when a prop changes" step SearchExperience uses, rather than
// in an effect one frame late.

import Link from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { AuthChrome } from "@/lib/authChrome";
import { useLang } from "@/lib/lang-client";
import { FOCUSABLE_SELECTOR, trapFocusIndex } from "@/lib/nav/focusTrap";
import { genreNavItems, isCurrent, isUnder, type NavEntry, type NavKey } from "@/lib/nav/navLinks";
import { useScrollLock } from "@/lib/scrollLock";
import { LanguageList } from "./LanguageMenu";
import NavAuthCta from "./NavAuthCta";
import styles from "./NavDrawer.module.css";

/** Above this width the drawer's ☰ is not on screen, so an open drawer closes. */
const DESKTOP_QUERY = "(min-width: 1024px)";

/** How long the closing slide runs before the drawer leaves the DOM. */
const CLOSE_MS = 220;

type Phase = "closed" | "open" | "closing";

interface NavDrawerProps {
  entries: NavEntry[];
  labels: Record<NavKey, string>;
  chrome: AuthChrome;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function NavDrawer({ entries, labels, chrome }: NavDrawerProps) {
  const { t } = useLang();
  const pathname = usePathname() ?? "/";
  const [phase, setPhase] = useState<Phase>("closed");
  const [shownOn, setShownOn] = useState(pathname);
  const drawerId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A new path closes it, during render — see the note at the top.
  if (shownOn !== pathname) {
    setShownOn(pathname);
    if (phase !== "closed") setPhase("closed");
  }

  const isOpen = phase === "open";

  const close = useCallback((restoreFocus: boolean) => {
    // No slide to wait for under reduced motion: gone at once.
    setPhase(prefersReducedMotion() ? "closed" : "closing");
    // After the frame that hides the dialog, so focus does not land on a
    // control that is about to become inert. Without scrolling: ☰ is in the
    // sticky bar, already on screen, and letting the browser "reveal" it
    // threw the page back to the top (Navbar.module.css).
    if (restoreFocus) {
      window.requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  // The closing slide runs, then the drawer leaves the DOM. Reopening during
  // the slide cancels it (the phase changes, so the cleanup clears the timer).
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setPhase("closed"), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useScrollLock(isOpen);

  // Growing past the phone layout hides ☰; an open drawer would be stranded.
  useEffect(() => {
    if (!isOpen) return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (query.matches) close(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [isOpen, close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.menuButton}
        aria-label={t("nav.openMenu")}
        aria-expanded={isOpen}
        // Only while the drawer exists: an id reference to nothing is a
        // broken relationship, not an empty one.
        aria-controls={phase !== "closed" ? drawerId : undefined}
        aria-haspopup="dialog"
        onClick={() => (isOpen ? close(true) : setPhase("open"))}
      >
        <svg className={styles.icon} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {phase !== "closed"
        ? createPortal(
            <DrawerPanel
              id={drawerId}
              phase={phase}
              entries={entries}
              labels={labels}
              chrome={chrome}
              onClose={close}
            />,
            document.body,
          )
        : null}
    </>
  );
}

interface DrawerPanelProps extends NavDrawerProps {
  id: string;
  phase: Phase;
  onClose: (restoreFocus: boolean) => void;
}

/**
 * The drawer itself. Mounted for as long as it is open or closing, so its own
 * state — whether the genre group is expanded — starts fresh on every open.
 */
function DrawerPanel({ id, phase, entries, labels, chrome, onClose }: DrawerPanelProps) {
  const { t, lang } = useLang();
  const pathname = usePathname() ?? "/";
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const genresId = useId();
  const languageId = useId();
  // Open on a genre hub, the group starts expanded so "where am I" is visible.
  const [genresOpen, setGenresOpen] = useState(() => isUnder(pathname, "/genre"));
  const genres = genreNavItems(lang);

  // Focus into the dialog as it opens. ✕ is at the top of a panel that has
  // just mounted, so it is in view; nothing needs scrolling to show it.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Escape closes; Tab and Shift+Tab stay inside.
  useEffect(() => {
    if (phase !== "open") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(true);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.getClientRects().length > 0);
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const target = trapFocusIndex(focusable.length, current, event.shiftKey);
      if (target === null) return;
      event.preventDefault();
      focusable[target].focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, onClose]);

  // Every link in here navigates somewhere; following one closes the drawer.
  const onPanelClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("a[href]")) onClose(true);
  };

  return (
    <div className={styles.root} data-state={phase}>
      <div className={styles.backdrop} aria-hidden="true" onClick={() => onClose(true)} />
      <div
        ref={panelRef}
        id={id}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("nav.menu")}
        inert={phase === "closing"}
        onClick={onPanelClick}
      >
        <div className={styles.head}>
          <Link href="/" prefetch={false} className={styles.logo}>
            AnimeGoClub
          </Link>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            aria-label={t("nav.closeMenu")}
            onClick={() => onClose(true)}
          >
            <svg className={styles.icon} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <ul className={styles.list}>
          {entries.map((entry) => {
            // The placeholder is a bar-only device for a box that is about to
            // be filled; the drawer opens long after the probe has answered.
            if (entry.placeholder) return null;
            const current = isCurrent(pathname, entry);
            if (entry.kind === "menu") {
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    className={styles.link}
                    aria-expanded={genresOpen}
                    aria-controls={genresId}
                    data-current={current}
                    onClick={() => setGenresOpen((v) => !v)}
                  >
                    {labels[entry.key]}
                    <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 10l5 5 5-5" />
                    </svg>
                  </button>
                  {genresOpen ? (
                    <ul id={genresId} className={styles.genres}>
                      {genres.map((genre) => (
                        <li key={genre.genre}>
                          <Link
                            href={genre.href}
                            prefetch={false}
                            className={styles.genre}
                            aria-current={isUnder(pathname, genre.href) ? "page" : undefined}
                          >
                            {genre.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            }
            return (
              <li key={entry.key}>
                <Link
                  href={entry.href}
                  prefetch={false}
                  className={styles.link}
                  aria-current={current ? "page" : undefined}
                >
                  {labels[entry.key]}
                </Link>
              </li>
            );
          })}
        </ul>

        <section className={styles.section} aria-labelledby={languageId}>
          <h2 id={languageId} className={styles.sectionTitle}>
            {t("nav.language")}
          </h2>
          <div className={styles.langs}>
            <LanguageList labelledBy={languageId} onPicked={() => onClose(false)} />
          </div>
        </section>

        {chrome === "anonymous" ? (
          <div className={styles.auth}>
            <NavAuthCta classes={{ login: styles.authLogin, register: styles.authRegister }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
