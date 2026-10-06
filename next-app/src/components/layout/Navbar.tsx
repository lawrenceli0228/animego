"use client";

// The site header, on every page.
//
// AniList's structure: the wordmark on the left, the links centred, search and
// the account on the right; transparent at the top of a page and glass once
// scrolled; out of the way while the reader scrolls down and back the moment
// they scroll up (useNavScroll → lib/nav/navScroll). Below 1024px it is the
// phone bar — ☰, wordmark, search, account — with the links in a drawer
// (NavDrawer). Styling: Navbar.module.css, which also explains the breakpoint.
//
// What it links to, in which order and when each link is "current" is
// lib/nav/navLinks, shared with the drawer.

import Link from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { hasAuthHint } from "@/lib/clientAuth";
import { authChrome } from "@/lib/authChrome";
import { authFetch } from "@/lib/authFetch";
import { isCurrent, navEntries, type NavKey } from "@/lib/nav/navLinks";
import { broadcastSignedOut } from "@/components/anime/subscriptionSetState";
import NotificationBell, { NotificationBellSkeleton } from "@/components/notifications/NotificationBell";
import AvatarMenu, { AvatarSkeleton } from "./AvatarMenu";
import GenreMenu from "./GenreMenu";
import { LanguageMenu } from "./LanguageMenu";
import NavAuthCta from "./NavAuthCta";
import NavDrawer from "./NavDrawer";
import NavSearch from "./NavSearch";
import { useNavScroll } from "./useNavScroll";
import styles from "./Navbar.module.css";

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

export default function Navbar({ season, year }: NavbarProps) {
  const pathname = usePathname() ?? "/";
  // Client i18n: the layout renders the canonical default (zh) and no longer
  // resolves lang server-side (that forced dynamic). useLang() is seeded from
  // the route locale and follows the reader after hydration, so the chrome
  // switches without a server round-trip.
  //
  // Neither `lang` nor `switchTo` is destructured here: every string in this
  // bar comes from t(), and the language control itself lives in
  // LanguageMenu (signed out) / AvatarMenu (signed in) / the drawer (phones).
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
  const [searchOpen, setSearchOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const { hidden, glass } = useNavScroll(headerRef);

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

  // The entries and the rule for 我的追番 in each auth state (absent /
  // same-width placeholder / link) are in lib/nav/navLinks, with the reasons.
  const entries = navEntries(chrome, seasonHref);
  // Literal t() calls, one per key, so spaDictCoverage.test.ts can see them.
  const labels: Record<NavKey, string> = {
    home: t("nav.home"),
    schedule: t("nav.schedule"),
    season: t("nav.season"),
    genres: t("nav.genres"),
    myList: t("nav.myList"),
    about: t("nav.about"),
  };

  return (
    <header
      ref={headerRef}
      className={styles.bar}
      data-hidden={hidden}
      data-glass={glass}
      data-search={searchOpen}
    >
      <nav className={styles.inner} aria-label={t("nav.mainNavigation")}>
        <div className={styles.start}>
          <NavDrawer entries={entries} labels={labels} chrome={chrome} />
          <Link href="/" className={styles.logo} prefetch={false}>
            AnimeGoClub
          </Link>
        </div>

        <ul className={styles.links}>
          {entries.map((entry) => {
            const current = isCurrent(pathname, entry);
            if (entry.kind === "menu") {
              return (
                <li key={entry.key}>
                  <GenreMenu triggerClassName={styles.link} label={labels[entry.key]} />
                </li>
              );
            }
            // Inert width reservation for 我的追番 while the probe is in flight.
            // `visibility: hidden` is what does the work: the box keeps its size
            // but the subtree leaves the accessibility tree, the tab order,
            // find-in-page and text selection — a screen reader, a keyboard and
            // Ctrl+F all agree it is not there. aria-hidden restates it for
            // anything that reads the tree without honouring the computed
            // style. Same class as the real link, so the reserved box is the
            // width of the link that will replace it rather than merely close.
            if (entry.placeholder) {
              return (
                <li key={entry.key}>
                  <span
                    aria-hidden="true"
                    className={`${styles.link} ${styles.placeholder}`}
                    data-current={current}
                  >
                    {labels[entry.key]}
                  </span>
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

        <div className={styles.end}>
          <NavSearch open={searchOpen} onOpenChange={setSearchOpen} />
          {chrome === "probing" ? (
            // auth_hint says a session likely exists but /api/auth/me hasn't
            // resolved — neutral placeholders the size of the bell and the
            // avatar, never the login CTA, so a signed-in reader doesn't flash
            // "login" first and nothing to the left jumps when they resolve.
            <>
              <NotificationBellSkeleton />
              <AvatarSkeleton />
            </>
          ) : user ? (
            // Signed-in chrome (Hi / 我的追番 / 我的库 / 设置 / language / 登出)
            // collapses into the avatar dropdown. 我的追番 is also a link in
            // the bar on purpose: the dropdown is an unlabelled affordance, and
            // a newly-subscribed reader needs a route back to their list that
            // they can actually see.
            <>
              <NotificationBell />
              <AvatarMenu user={user} onLogout={handleLogout} loggingOut={loggingOut} />
            </>
          ) : (
            <>
              {/* Was a two-state flip labelled "Switch to English" / "切换到中文",
                  sitting on top of nextLocale() — which is an N-way cycle. The
                  label described the button only while there were exactly two
                  locales. LanguageMenu derives its options from LOCALES. On a
                  phone there is no room for it; the drawer carries the list. */}
              <span className={styles.desktopOnly}>
                <LanguageMenu />
              </span>
              <NavAuthCta classes={{ login: styles.login, register: styles.register }} />
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
