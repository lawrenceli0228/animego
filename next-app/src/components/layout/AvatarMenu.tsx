"use client";

import Link from "@/components/ui/LocaleLink";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/lib/lang-client";
import { DEFAULT_AVATAR_IMAGE, DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import { cssUrl } from "@/lib/cssUrl";
import FallbackImg from "@/components/ui/FallbackImg";
import type { NavUser } from "./Navbar";
import { LanguageMenuInline } from "./LanguageMenu";
import styles from "./AvatarMenu.module.css";

// AvatarMenu — the signed-in navbar chrome collapsed into the member's face.
// The face is the member-pass photo when set, else the chosen anime's cover,
// else the default card; the dropdown integrates the account's functions and
// 设置 links to /settings.

interface AvatarMenuProps {
  user: NavUser;
  onLogout: () => void;
  loggingOut: boolean;
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}

/**
 * The neutral stand-in Navbar shows while the session probe is in flight.
 *
 * Built from the trigger's own classes, so its footprint IS the trigger's —
 * the probe resolving swaps a box for one of identical size and nothing in
 * the bar moves. (It used to be a hand-copied width/height/radius that had to
 * be kept in step with the stylesheet by eye.)
 */
export function AvatarSkeleton() {
  return (
    <span className={`${styles.trigger} ${styles.skeleton}`} aria-hidden="true">
      <span className={styles.face} />
      <span className={styles.skeletonChevron} />
    </span>
  );
}

export default function AvatarMenu({ user, onLogout, loggingOut }: AvatarMenuProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  // The dropdown is mounted on the first open and kept, so it can fade out as
  // well as in — and so a signed-in page view that never opens it never
  // fetches the banner it carries.
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const hadFocus = wrapRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (hadFocus) triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const photo = user.avatarUrl ?? null;
  const cover = user.backdropCoverUrl ?? null;
  // Banner falls back to cover then the default, so the mini-card is never an
  // empty dark strip.
  const banner = user.backdropBannerUrl ?? user.backdropCoverUrl ?? DEFAULT_BACKDROP_IMAGE;
  // The face: the photo, else the chosen anime's cover, else the default
  // card. The cover is an AniList URL that can rotate/404, so FallbackImg
  // swaps to the default on error.
  const avatarSrc = photo ?? cover ?? DEFAULT_AVATAR_IMAGE;

  const avatar = () => (
    <FallbackImg src={avatarSrc} fallback={DEFAULT_AVATAR_IMAGE} alt={user.username} />
  );

  const close = () => setOpen(false);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.accountMenu")}
        onClick={() => {
          setMounted(true);
          setOpen((v) => !v);
        }}
      >
        <span className={styles.face}>{avatar()}</span>
        <Chevron />
      </button>

      {mounted && (
        <div className={styles.menu} role="menu" data-open={open}>
          <div className={styles.head}>
            {banner && (
              <span
                className={styles.headBanner}
                style={{ backgroundImage: cssUrl(banner, DEFAULT_BACKDROP_IMAGE) }}
                aria-hidden="true"
              />
            )}
            <span className={styles.headFace}>{avatar()}</span>
            <span className={styles.name}>
              <b>{user.username}</b>
              <span>{t("nav.hi")}</span>
            </span>
          </div>

          <Link
            href="/profile"
            prefetch={false}
            className={styles.item}
            role="menuitem"
            onClick={close}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            {t("nav.myList")}
          </Link>

          {/* 我的库 lives here, not in the bar. It is the local-file player:
              needs File System Access plus a folder the user has granted, and
              is auth-gated by proxy.ts either way — so as a top-level entry it
              spends a slot on something a first-time visitor cannot use.
              (lib/nav/navLinks holds the bar's side of this decision.) */}
          <Link
            href="/library"
            prefetch={false}
            className={styles.item}
            role="menuitem"
            onClick={close}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {t("nav.library")}
          </Link>

          <Link
            href="/settings"
            prefetch={false}
            className={styles.item}
            role="menuitem"
            onClick={close}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t("settings.kicker")}
          </Link>

          {user.role === "admin" && (
            <Link
              href="/admin"
              prefetch={false}
              className={styles.item}
              role="menuitem"
              onClick={close}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l8 4v6c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" />
              </svg>
              {t("admin.title", { defaultValue: "Admin" })}
            </Link>
          )}

          {/* Was one row reading "语言   中 / EN" — a hardcoded two-language
              readout over an N-way cycle, which stopped describing what the
              button did the moment a third locale existed. Now a group of
              options derived from LOCALES, each named in its own language. */}
          <LanguageMenuInline onPicked={close} />

          <div className={styles.separator} />

          <button
            type="button"
            className={`${styles.item} ${styles.danger}`}
            role="menuitem"
            disabled={loggingOut}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t("nav.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
