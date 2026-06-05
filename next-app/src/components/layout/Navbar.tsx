"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import { hasAuthHint } from "@/lib/clientAuth";
import { authChrome } from "@/lib/authChrome";
import { authFetch } from "@/lib/authFetch";
import AvatarMenu from "./AvatarMenu";

export interface NavUser {
  username: string;
  role?: string | null;
  /** DB-persisted pass photo, shown as the avatar when set. */
  avatarUrl?: string | null;
  /** Chosen backdrop anime's wide banner — themes the dropdown mini-card. */
  backdropBannerUrl?: string | null;
  /** Chosen backdrop anime's cover — fills the avatar tile when no photo. */
  backdropCoverUrl?: string | null;
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
  // Neutral stand-in for the avatar while the auth probe is in flight — matches
  // the .agc-avatar tile footprint (36x36, radius 8) so the swap to the real
  // avatar causes no layout shift.
  avatarSkeleton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    background: "rgba(255,255,255,0.08)",
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
  // `probing` covers the window where the non-httpOnly auth_hint cookie says a
  // session probably exists but the /api/auth/me probe hasn't resolved yet. In
  // that window we render a neutral avatar placeholder instead of the
  // login/register CTA, so a logged-in visitor never flashes "login" first.
  const [probing, setProbing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // hasAuthHint() reads the non-httpOnly `auth_hint` cookie (client-only), so
    // this resolves post-hydration. No hint → genuinely anonymous; leave the
    // login/register CTA. Hint present → flip `probing` first so the chrome
    // shows a neutral avatar placeholder (NOT the login CTA) while the probe is
    // in flight, then swaps straight to the avatar. Without this a logged-in
    // visitor sees a ~0.5s "login" flash before their avatar appears — very
    // visible now the page paints instantly from the CF edge cache.
    //
    // setState lives inside the async helper (never synchronously in the effect
    // body) to satisfy react-hooks/set-state-in-effect.
    const resolve = async () => {
      if (!hasAuthHint()) return;
      if (!cancelled) setProbing(true);
      try {
        // authFetch self-heals an expired 15-min `session` via the 7-day
        // refresh cookie; skipRedirectOnFailure so a truly-expired visitor
        // renders anonymous instead of bouncing to /login.
        const r = await authFetch("/api/auth/me", { skipRedirectOnFailure: true });
        const json = r.ok ? await r.json() : null;
        if (!cancelled) setUser(json?.data?.user ?? null);
      } catch {
        /* network blip — keep the last known state */
      } finally {
        if (!cancelled) setProbing(false);
      }
    };
    // Re-runs on pathname change so a fresh client-side login (LoginForm
    // navigates here) updates the nav without a manual page reload.
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

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

  // "authed" → avatar · "probing" → neutral skeleton (never the login CTA mid-
  // probe) · "anonymous" → login/register. See lib/authChrome.
  const chrome = authChrome(Boolean(user), probing);

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
              className="nav-link"
              style={s.link(isActive(pathname, l.href))}
              aria-current={isActive(pathname, l.href) ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div style={s.right}>
          {chrome === "probing" ? (
            // auth_hint says a session likely exists but /api/auth/me hasn't
            // resolved — show a neutral avatar placeholder, never the login CTA,
            // so a logged-in visitor doesn't flash "login" before their avatar.
            <div style={s.avatarSkeleton} aria-hidden />
          ) : user ? (
            // Logged-in chrome (Hi / 我的追番 / language / 登出) collapses into
            // the avatar dropdown, which also hosts 卡片个性化.
            <AvatarMenu
              user={user}
              onLogout={handleLogout}
              loggingOut={loggingOut}
            />
          ) : (
            <>
              <button
                type="button"
                style={s.langBtn}
                onClick={toggle}
                aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
              >
                {lang === "zh" ? "EN" : "中"}
              </button>
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
