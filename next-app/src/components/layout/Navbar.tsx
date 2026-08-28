"use client";

import Link from "@/components/ui/LocaleLink";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import {
  authHrefWithFrom,
  type AuthSurface,
} from "@/components/auth/authFromLink";
import toast from "react-hot-toast";
import { hasAuthHint } from "@/lib/clientAuth";
import { authChrome } from "@/lib/authChrome";
import { authFetch } from "@/lib/authFetch";
import { broadcastSignedOut } from "@/components/anime/subscriptionSetState";
import AvatarMenu from "./AvatarMenu";
import { LanguageMenu } from "./LanguageMenu";
import NotificationBell from "@/components/notifications/NotificationBell";
import { splitLocale } from "@/lib/i18n/locale";

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
  // The link strip is the ONLY shrinkable region in the bar. A flex item
  // defaults to `min-width: auto` (= min-content), so before this the strip
  // refused to shrink and shoved the login/register/avatar chrome past the
  // right edge — where globals.css `overflow-x: hidden` clipped it, making it
  // unreachable rather than merely ugly (375px: ~567px of min-content in
  // 327px of room). minWidth:0 lets it give way; overflowX makes the surplus
  // links scrollable instead of lost.
  links: {
    display: "flex",
    gap: 4,
    flex: 1,
    minWidth: 0,
    overflowX: "auto",
    scrollbarWidth: "none",
    overscrollBehaviorX: "contain",
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
  // flexShrink:0 — this column holds the only path to login and to the account
  // menu, so it wins every width fight against the link strip above.
  right: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginLeft: "auto",
    flexShrink: 0,
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
  username: {
    fontSize: 13,
    color: "rgba(235,235,245,0.75)",
    padding: "0 4px",
  } as CSSProperties,
  // Neutral stand-in for the avatar while the auth probe is in flight. Must
  // track .agc-avatar's footprint EXACTLY (size + radius) or the probe
  // resolving jolts the whole right-hand group. Kept in sync by hand because
  // the tile's own rules live in avatar-menu.css (media queries and :hover
  // cannot be expressed inline).
  avatarSkeleton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "rgba(255,255,255,0.08)",
  } as CSSProperties,
};

// Everything inline styles cannot express: media queries, the WebKit
// scrollbar pseudo-element, and descendant selectors. `!important` is not
// decoration here — the elements below carry inline `style` objects, which
// otherwise outrank any stylesheet rule (same trick as /search's grid).
//
// Scope of the mobile pass is deliberately narrow: tighten the gutters and
// let the link strip scroll. No hamburger, no drawer — the goal is only that
// 登录 / 注册 / avatar stop falling outside the viewport at 375px.
const NAV_CSS = `
.agc-nav-links::-webkit-scrollbar { display: none; }
.agc-nav-links > * { flex: 0 0 auto; white-space: nowrap; }
@media (max-width: 768px) {
  .agc-nav { padding: 0 12px !important; }
  .agc-nav-inner { gap: 12px !important; }
  .agc-nav-logo { font-size: 17px !important; }
  .agc-nav-links > * { padding-left: 10px !important; padding-right: 10px !important; }
  /* Keep the hover underline inside the tightened padding box. */
  .agc-nav-links .nav-link::after { left: 10px; right: 10px; }
}
@media (max-width: 480px) {
  .agc-nav-logo { font-size: 16px !important; }
  .agc-nav-cta { padding: 6px 10px !important; font-size: 13px !important; }
}
`;

// Same payload shape proxy.ts:216 and authFetch:71 already produce —
// pathname + search, never an absolute URL, because sanitizeFromParam only
// accepts a same-origin path. authHrefWithFrom owns the rest of the rule
// (root, self-loop and off-origin values degrade to the bare surface); this
// bar used to carry its own looser copy of it, and two hand-mirrored copies
// of one security allowlist is exactly one too many.
function navAuthHref(
  target: AuthSurface,
  pathname: string,
  search: string,
): string {
  return authHrefWithFrom(target, search ? `${pathname}?${search}` : pathname);
}

interface AuthCtaProps {
  loginHref: string;
  registerHref: string;
}

// Presentational half of the logged-out chrome, split out so the identical
// markup can render on both sides of the Suspense boundary below.
function AuthCtaView({ loginHref, registerHref }: AuthCtaProps) {
  const { t } = useLang();
  return (
    <>
      {/* Was a two-state flip labelled "Switch to English" / "切换到中文",
          sitting on top of nextLocale() — which is an N-way cycle. The label
          described the button only while there were exactly two locales.
          LanguageMenu derives its options from LOCALES instead. */}
      <LanguageMenu />
      <Link href={loginHref} prefetch={false} className="agc-nav-cta" style={s.btnOutline}>
        {t("nav.login")}
      </Link>
      <Link href={registerHref} prefetch={false} className="agc-nav-cta" style={s.btnFill}>
        {t("nav.register")}
      </Link>
    </>
  );
}

// useSearchParams() lives HERE, behind its own <Suspense>, and not in Navbar:
// Navbar renders from the root layout and /anime/* is prerendered (ISR), and
// an unwrapped useSearchParams() anywhere in a prerendered tree fails the
// production build with "Missing Suspense boundary with useSearchParams".
// The fallback is the same two buttons minus the ?from= round-trip, so the
// prerendered HTML is complete and the client swap is invisible.
function AuthCtaWithFrom() {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams()?.toString() ?? "";
  return (
    <AuthCtaView
      loginHref={navAuthHref("/login", pathname, search)}
      registerHref={navAuthHref("/register", pathname, search)}
    />
  );
}

// Compares the un-prefixed path, because the nav hrefs are written without
// a locale. Matching the raw pathname meant "/en/search" never equalled
// "/search", so the active highlight and aria-current were dead across the
// whole English tree — a nav that never marks where you are, and no
// current-page announcement for a screen reader.
function isActive(pathname: string, href: string): boolean {
  const { path } = splitLocale(pathname);
  if (href === "/") return path === "/";
  return path === href || path.startsWith(href + "/");
}

interface NavLink {
  href: string;
  label: string;
  key: string;
  /**
   * Render the label as an inert, `visibility: hidden` span instead of a link.
   * Used for the auth-only entry in every state except "authed": it reserves
   * the exact width the real link will occupy, so the strip is the same shape
   * from the first painted frame onward, without ever exposing a logged-in-only
   * affordance to a visitor who has not resolved a session.
   */
  placeholder?: boolean;
}

export default function Navbar({ season, year }: NavbarProps) {
  const pathname = usePathname() ?? "/";
  // Client i18n: the layout renders the canonical default (zh) and no longer
  // resolves lang server-side (that forced dynamic). useLang() is seeded from
  // the route locale and follows the reader after hydration, so the chrome
  // switches without a server round-trip.
  //
  // Neither `lang` nor `switchTo` is destructured here any more: every string
  // in this bar now comes from t(), and the language control itself moved into
  // LanguageMenu (logged-out) / AvatarMenu (logged-in).
  const { t } = useLang();

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

    // `cleared` means go-api answered 200, which is the ONLY evidence that the
    // three auth cookies are gone. They are httpOnly, so this component cannot
    // clear them itself and cannot check them — a logged-out UI is a claim
    // about server state, and it has to be earned.
    //
    // ── WHY res.ok AND NOT JUST try/catch ──
    // fetch RESOLVES on 4xx/5xx; only a network-level failure rejects. So a
    // bare `await fetch(...)` inside try/catch treats every error status as
    // success. That is not hypothetical here: /api/auth/logout sits behind two
    // independent per-IP rate limiters (auth.RateLimiter in main.go and the
    // global httpmw.NewAPIRateLimiter — POST is not covered by the GET-only
    // catalog exemption), and BOTH answer 429 from middleware, before the
    // handler runs and therefore before any Clear-Cookie header is written.
    // Shared-exit-IP networks make that reachable in normal use.
    //
    // The previous version of this comment claimed "the route no longer
    // requires an access token and always clears cookies, so the only
    // remaining gap is the request not arriving at all." That was wrong, and
    // wrong in exactly the way the comment it replaced was wrong: it asserted
    // a guarantee the routing layer does not provide. The handler always
    // clears cookies; the handler does not always run.
    //
    // Getting this wrong reinstates the original bug. The UI would go
    // logged-out while a 7-day refresh cookie stayed live, and proxy.ts would
    // spend it on the next navigation — on a shared machine, signing the next
    // person in as the previous user.
    let cleared = false;
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      cleared = res.ok;
    } catch {
      // Network-level failure: the request may or may not have reached go-api.
      // Treated as "not cleared" because that is the safe direction — claiming
      // failure on a logout that actually succeeded costs one confused user
      // and a 401 on their next action; claiming success on one that did not
      // costs the session.
      cleared = false;
    }

    if (!cleared) {
      // Stay signed in, visibly. Retrying is pointless for a 429 (the window
      // is 15 minutes) and the client has no way to force the cookies out, so
      // the honest move is to leave the bar reading as signed-in and say so.
      toast.error(t("nav.logoutFailed"));
      setLoggingOut(false);
      return;
    }

    // go-api also clears the auth_hint cookie; reflect logged-out state now.
    setUser(null);
    // ...and tell every mounted SubscriptionSetProvider to drop the set it
    // cached for the account that just left. Logging out deliberately does NOT
    // navigate — you stay on the page you were reading — so nothing else in the
    // tree has any reason to re-render. Without this signal the previous user's
    // ✓ badges stay painted across the whole grid, underneath a bar that
    // already reads 登录 / 注册, until some unrelated route change wipes them.
    // On a shared machine that is the next person standing in front of a
    // stranger's complete watchlist on a page that claims nobody is signed in.
    //
    // Deliberately not a full-page window.location.replace(): that would turn
    // logout into a navigation and undo the stay-put design. The event is the
    // narrow fix — evict the one piece of per-user state that outlives it.
    broadcastSignedOut();
    setLoggingOut(false);
  }

  // "authed" → avatar · "probing" → neutral skeleton (never the login CTA mid-
  // probe) · "anonymous" → login/register. See lib/authChrome.
  const chrome = authChrome(Boolean(user), probing);

  // 我的追番 (/profile) takes over the slot 我的库 (/library) vacated, so the
  // link count is unchanged — the bar is already over budget at 375px.
  //
  // Why the swap: /profile is the one surface whose value grows with every
  // subscription, and it lived ONLY behind the unlabelled 36×36 avatar
  // dropdown, so a user who had just subscribed to their first show had no
  // visible route back to their list. /library, meanwhile, is the local-file
  // player — it needs File System Access plus a granted folder, is auth-gated
  // by proxy.ts anyway, and is pure confusion as a top-level entry for a
  // first-time visitor. It moves into AvatarMenu.
  //
  // The entry is in the array in EVERY auth state and only its rendering
  // changes: "authed" gets the real <Link>, "probing" and "anonymous" get an
  // inert same-width span. Two independent reasons, and they pull in opposite
  // directions, which is why neither "always link" nor "conditionally present"
  // works:
  //
  //   1. Layout. `chrome` is "anonymous" in the prerendered HTML and flips to
  //      "probing" one frame after hydration for every visitor carrying
  //      auth_hint. An entry that only appeared at that flip shoved 关于 right
  //      by a full link width on every page load and every navigation — worst
  //      on /anime/*, which paints instantly off the CF edge cache, so the
  //      jump lands well after the user has started reading the bar.
  //   2. Auth. Only "authed" may get a live /profile link: the route sits
  //      behind the proxy.ts gate, so an anonymous click earns nothing but a
  //      bounce to /login, and showing a logged-in-only affordance mid-probe
  //      is the same 2026-06-05 phantom-logout mistake the avatar skeleton
  //      exists to avoid, just applied to a link instead of a button.
  //
  // Reserved for "probing" ONLY — never for anonymous.
  //
  // An earlier revision reserved the width in both states, on the theory that a
  // bar which never moves beats a bar that settles once. Rendered, that is a
  // visible gap sitting between 搜索 and 关于 on every anonymous page view: the
  // strip reads as broken markup rather than as a stable layout, and anonymous
  // is the majority of traffic (SEO lands people logged out, and most never
  // return to log in at all). It traded a permanent defect for the majority
  // against a one-frame settle for the minority.
  //
  // Probing is the only state where reserving pays for itself: it is entered
  // solely when the auth_hint cookie is present, so a real link is already on
  // its way and the box will be filled within one round trip. Anonymous
  // visitors have nothing coming, so they get no box.
  const links: NavLink[] = [
    { href: "/", label: t("nav.home"), key: "home" },
    { href: seasonHref, label: t("nav.season"), key: "season" },
    { href: "/search", label: t("nav.search"), key: "search" },
    ...(chrome === "anonymous"
      ? []
      : [
          {
            href: "/profile",
            label: t("nav.myList"),
            key: "mylist",
            placeholder: chrome !== "authed",
          },
        ]),
    { href: "/welcome", label: t("nav.about"), key: "about" },
  ];

  return (
    <nav
      className="agc-nav"
      style={s.nav}
      aria-label={t("nav.mainNavigation")}
    >
      <style>{NAV_CSS}</style>
      <div className="agc-nav-inner" style={s.inner}>
        <Link href="/" className="agc-nav-logo" style={s.logo} prefetch={false}>
          AnimeGoClub
        </Link>
        <div className="agc-nav-links" style={s.links}>
          {links.map((l) => {
            const active = isActive(pathname, l.href);
            // Inert width reservation. `visibility: hidden` is what does the
            // work: the box keeps its size but the subtree leaves the
            // accessibility tree, the tab order, find-in-page and text
            // selection — a screen reader, a keyboard and Ctrl+F all agree it
            // is not there. aria-hidden restates it for anything that reads
            // the tree without honouring the computed style. It is styled with
            // the SAME active flag as the real link, so the reserved box is
            // the width of the link that will replace it (600-weight when
            // active, 500 otherwise) rather than merely close to it.
            //
            // Anonymous and probing visitors emit byte-identical markup here,
            // so the placeholder's presence says nothing about whether anyone
            // is signed in — it is not a hidden copy of a logged-in nav, it is
            // a spacer that happens to be shaped like one.
            return l.placeholder ? (
              <span
                key={l.key}
                aria-hidden="true"
                style={{ ...s.link(active), visibility: "hidden" }}
              >
                {l.label}
              </span>
            ) : (
              <Link
                key={l.key}
                href={l.href}
                prefetch={false}
                className="nav-link"
                style={s.link(active)}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
        <div className="agc-nav-right" style={s.right}>
          {chrome === "probing" ? (
            // auth_hint says a session likely exists but /api/auth/me hasn't
            // resolved — show a neutral avatar placeholder, never the login CTA,
            // so a logged-in visitor doesn't flash "login" before their avatar.
            <div style={s.avatarSkeleton} aria-hidden />
          ) : user ? (
            // Logged-in chrome (Hi / 我的追番 / 我的库 / 设置 / language / 登出)
            // collapses into the avatar dropdown. 我的追番 is duplicated in the
            // nav strip above on purpose: the dropdown is a 36×36 unlabelled
            // affordance, and a newly-subscribed user needs a route back to
            // their list that they can actually see.
            <>
              <NotificationBell />
              <AvatarMenu
                user={user}
                onLogout={handleLogout}
                loggingOut={loggingOut}
              />
            </>
          ) : (
            <Suspense
              fallback={<AuthCtaView loginHref="/login" registerHref="/register" />}
            >
              <AuthCtaWithFrom />
            </Suspense>
          )}
        </div>
      </div>
    </nav>
  );
}
