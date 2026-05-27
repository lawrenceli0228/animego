"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import type { CSSProperties } from "react";
import type { Dict, Lang } from "@/lib/i18n";

export interface NavUser {
  username: string;
  role?: string | null;
}

interface NavbarProps {
  dict: Dict;
  lang: Lang;
  /**
   * Current season and year resolved server-side so the Season link goes
   * to the live /seasonal/[s]/[y] route. Phase 6 will read these from a
   * route-level config or a /seasonal redirect handler.
   */
  season: string;
  year: number;
  /**
   * SSR-resolved user from /api/auth/me (forwarded via buildHeaders'
   * cookie). null = anonymous (show login/register CTAs). P6.9 work —
   * the auth-state hole the original "Phase 6 work" comment flagged.
   */
  user?: NavUser | null;
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

export default function Navbar({
  dict,
  lang,
  season,
  year,
  user,
}: NavbarProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Season link points at the live /seasonal route (legacy /season has
  // no params; next-app uses /seasonal/[season]/[year]).
  const seasonHref = `/seasonal/${season.toLowerCase()}/${year}`;

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      /* swallow — local cookie still gets cleared server-side */
    }
    // router.refresh re-runs the layout server fetch so the Navbar
    // re-renders with user=null and the route-level proxy.ts gates
    // catch the now-missing session cookie.
    startTransition(() => router.refresh());
  }

  const links: Array<{ href: string; label: string; key: string }> = [
    { href: "/", label: dict.nav.home, key: "home" },
    { href: seasonHref, label: dict.nav.season, key: "season" },
    { href: "/search", label: dict.nav.search, key: "search" },
    { href: "/library", label: dict.nav.library, key: "library" },
    { href: "/welcome", label: dict.nav.about, key: "about" },
  ];

  function toggleLang() {
    const next = lang === "zh" ? "en" : "zh";
    // 1y expiry, same-site, root path so all routes see the switch.
    document.cookie = `lang=${next}; max-age=${60 * 60 * 24 * 365}; path=/; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <nav style={s.nav} aria-label={lang === "zh" ? "主导航" : "Main navigation"}>
      <div style={s.inner}>
        <Link href="/" style={s.logo} prefetch={false}>
          AnimeGo
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
            onClick={toggleLang}
            disabled={pending}
            aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
          {/* P6.9: SSR-resolved auth state. user is fetched in
              src/app/layout.tsx via apiGet('/api/auth/me'), forwarded
              cookie-authenticated. null → anonymous CTAs; logged in →
              greeting + admin-conditional admin link + my-list +
              logout. Logout calls /api/auth/logout and then
              router.refresh() so the next render's layout fetch sees
              the cleared session cookie. */}
          {user ? (
            <>
              <span style={s.username}>
                {dict.nav.hi}, {user.username}
              </span>
              {user.role === "admin" && (
                <Link href="/admin" prefetch={false} style={s.btnOutline}>
                  {dict.admin.title}
                </Link>
              )}
              {/* /profile is still the legacy Express SPA route (P9 残余).
                  Use plain <a> for a full-page nav so nginx routes the
                  request to the Express upstream instead of next-router
                  pushing client-side to a 404 on the next-app side. */}
              <a href="/profile" style={s.btnOutline}>
                {dict.nav.myList}
              </a>
              <button
                type="button"
                onClick={handleLogout}
                disabled={pending}
                style={s.btnOutline}
              >
                {dict.nav.logout}
              </button>
            </>
          ) : (
            <>
              <Link href="/login" prefetch={false} style={s.btnOutline}>
                {dict.nav.login}
              </Link>
              <Link href="/register" prefetch={false} style={s.btnFill}>
                {dict.nav.register}
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
