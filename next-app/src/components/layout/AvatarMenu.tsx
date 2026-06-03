"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/lib/lang-client";
import { DEFAULT_CARD_IMAGE, DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import { cssUrl } from "@/lib/cssUrl";
import FallbackImg from "@/components/ui/FallbackImg";
import type { NavUser } from "./Navbar";
import "./avatar-menu.css";

// AvatarMenu — the logged-in navbar chrome collapsed into a circular avatar.
// The avatar shows the member-pass photo when set (else the username initial),
// and the dropdown integrates the user's functions; 设置 links to /settings.

interface AvatarMenuProps {
  user: NavUser;
  onLogout: () => void;
  loggingOut: boolean;
}

export default function AvatarMenu({ user, onLogout, loggingOut }: AvatarMenuProps) {
  const { lang, t, toggle } = useLang();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const zh = lang === "zh";
  const photo = user.avatarUrl ?? null;
  const cover = user.backdropCoverUrl ?? null;
  // Banner falls back to cover then the default, so the mini-card is never an
  // empty dark strip.
  const banner = user.backdropBannerUrl ?? user.backdropCoverUrl ?? DEFAULT_BACKDROP_IMAGE;
  // Square tile: the photo, else the chosen anime's cover, else the default
  // card. The cover is an AniList URL that can rotate/404, so FallbackImg
  // swaps to the default on error.
  const avatarSrc = photo ?? cover ?? DEFAULT_CARD_IMAGE;

  const avatar = () => (
    <FallbackImg src={avatarSrc} fallback={DEFAULT_CARD_IMAGE} alt={user.username} />
  );

  return (
    <div className="agc-avatar-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agc-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={zh ? "账户菜单" : "Account menu"}
        onClick={() => setOpen((v) => !v)}
      >
        {avatar()}
      </button>

      {open && (
        <div className="agc-avatar-menu" role="menu">
          <div className="agc-avatar-head">
            {banner && (
              <span
                className="agc-avatar-head-banner"
                style={{ backgroundImage: cssUrl(banner, DEFAULT_BACKDROP_IMAGE) }}
                aria-hidden="true"
              />
            )}
            <span className="agc-avatar">{avatar()}</span>
            <span className="nm">
              <b>{user.username}</b>
              <span>{t("nav.hi")}</span>
            </span>
          </div>

          <Link
            href="/profile"
            prefetch={false}
            className="agc-menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
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

          <Link
            href="/settings"
            prefetch={false}
            className="agc-menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {zh ? "用户设置" : "Settings"}
          </Link>

          {user.role === "admin" && (
            <Link
              href="/admin"
              prefetch={false}
              className="agc-menu-item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l8 4v6c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" />
              </svg>
              {t("admin.title", { defaultValue: "Admin" })}
            </Link>
          )}

          <button
            type="button"
            className="agc-menu-item"
            role="menuitem"
            onClick={toggle}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
            </svg>
            {zh ? "语言" : "Language"}
            <span className="spacer">{zh ? "中 / EN" : "EN / 中"}</span>
          </button>

          <div className="agc-menu-sep" />

          <button
            type="button"
            className="agc-menu-item danger"
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
