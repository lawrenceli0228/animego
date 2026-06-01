"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import { hasAuthHint } from "@/lib/clientAuth";

export interface NavUser {
  username: string;
  role?: string | null;
}

interface NavbarProps {
  /**
   * Current season + year resolved server-side so the Season link targets
   * the live /seasonal/[s]/[y] route. These are deterministic (date-based),
   * not per-user, so they don't force dynamic rendering.
   */
  season: string;
  year: number;
}

const s = {
  nav: {
    position: "sticky" as const,
    top: 0,
    zIndex: 100,
    background: "rgba(0,0,0,0.80)",
    backdropFilter: "saturate(180%) blur(20px)",
    WebkitBackdropFilter: "saturate(180%) blur(20px)",
    borderBottom: "1px solid rgba(84,84,88,0.65)",
    padding: "0 24px",
  } as CSSProperties,
  inner: {
    maxWidth: 1400,
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    height: 56,
    gap: 32,
  } as CSSProperties,
  logo: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 20,
    letterSpacing: "-0.03em",
    color: "#ffffff",
    textDecoration: "none",
  } as CSSProperties,
  links: {
    display: "flex",
    gap: 4,
    flex: 1,
  } as CSSProperties,
  link: (active: boolean): CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: active ? 600 : 500,
    color: active ? "#ffffff" : "rgba(235,235,245,0.60)",
    background: active ? "rgba(255,255,255,0.10)" : "transparent",
    transition: "all 0.2s",
    textDecoration: "none",
  }),
  right: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginLeft: "auto",
  } as CSSProperties,
  btnOutline: {
    padding: "6px 16px",
    borderRadius: 8,
    border: "1px solid rgba(84,84,88,0.65)",
    color: "rgba(235,235,245,0.60)",
    fontSize: 14,
    fontWeight: 500,
    transition: "all 0.2s",
    cursor: "pointer",
    background: "none",
    textDecoration: "none",
  } as CSSProperties,
  btnFill: {
    padding: "6px 16px",
    borderRadius: 8,
    background: "#0a84ff",
    color: "#fff",
    fontSize: 14,
    fontWeight: 500,
    border: "none",
    cursor: "pointer",
    textDecoration: "none",
  } as CSSProperties,
  langBtn: {
    minHeight: 36,
    minWidth: 40,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(84,84,88,0.65)",
    color: "rgba(235,235,245,0.60)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    background: "none",
    transition: "all 0.2s",
  } as CSSProperties,
  username: {
    fontSize: 13,
    color: "rgba(235,235,245,0.75)",
    padding: "0 4px",
  } as CSSProperties,
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export default function Navbar({ season, year }: NavbarProps) {
  const pathname = usePathname() ?? "/";
  // Client i18n: the layout renders the canonical default (zh) and no longer
  // resolves lang server-side (that forced dynamic). useLang() reads the
  // `lang` cookie on the client + reacts to the toggle, so the chrome
  // switches to en for en visitors without a server round-trip.
  const { lang, t, toggle } = useLang();

  // Islanded auth state: the layout no longer fetches /api/auth/me server-side
  // (that no-store call forced every page dynamic). Fetch it here, on mount,
  // and ONLY when the non-httpOnly `auth_hint` cookie says a session likely
  // exists — so an anonymous page load fires zero auth requests (ISSUE-001).
  const [user, setUser] = useState<NavUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (!hasAuthHint()) return;
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled) setUser(json?.data?.user ?? null);
      })
      .catch(() => {
        /* network / 401 — stay anonymous */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Season link points at the live /seasonal route (legacy /season has no
  // params; next-app uses /seasonal/[season]/[year]).
  const seasonHref = `/seasonal/${season.toLowerCase()}/${year}`;

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      /* swallow — the server still clears the cookies */
    }
    // go-api also clears the auth_hint cookie; reflect logged-out state now.
    setUser(null);
    setLoggingOut(false);
  }

  const links: Array<{ href: string; label: string; key: string }> = [
    { href: "/", label: t("nav.home"), key: "home" },
    { href: seasonHref, label: t("nav.season"), key: "season" },
    { href: "/search", label: t("nav.search"), key: "search" },
    { href: "/library", label: t("nav.library"), key: "library" },
    { href: "/welcome", label: t("nav.about"), key: "about" },
  ];

  return (
    <nav style={s.nav} aria-label={lang === "zh" ? "主导航" : "Main navigation"}>
      <div style={s.inner}>
        <Link href="/" style={s.logo} prefetch={false}>
          AnimeGoClub
        </Link>
        <div style={s.links}>
          {links.map((l) => (
            <Link
              key={l.key}
              href={l.href}
              prefetch={false}
              style={s.link(isActive(pathname, l.href))}
              aria-current={isActive(pathname, l.href) ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div style={s.right}>
          <button
            type="button"
            style={s.langBtn}
            onClick={toggle}
            aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
          {user ? (
            <>
              <span style={s.username}>
                {t("nav.hi")}, {user.username}
              </span>
              {user.role === "admin" && (
                <Link href="/admin" prefetch={false} style={s.btnOutline}>
                  {t("admin.title", { defaultValue: "Admin" })}
                </Link>
              )}
              <Link href="/profile" prefetch={false} style={s.btnOutline}>
                {t("nav.myList")}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
                style={s.btnOutline}
              >
                {t("nav.logout")}
              </button>
            </>
          ) : (
            <>
              <Link href="/login" prefetch={false} style={s.btnOutline}>
                {t("nav.login")}
              </Link>
              <Link href="/register" prefetch={false} style={s.btnFill}>
                {t("nav.register")}
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
