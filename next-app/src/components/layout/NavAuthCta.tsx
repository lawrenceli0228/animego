"use client";

// 登录 / 注册 — the signed-out chrome, in the bar and in the phone drawer.

import Link from "@/components/ui/LocaleLink";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { authHrefWithFrom, type AuthSurface } from "@/components/auth/authFromLink";
import { useLang } from "@/lib/lang-client";

export interface AuthCtaClasses {
  login: string;
  register: string;
}

// Same payload shape proxy.ts:216 and authFetch:71 already produce —
// pathname + search, never an absolute URL, because sanitizeFromParam only
// accepts a same-origin path. authHrefWithFrom owns the rest of the rule
// (root, self-loop and off-origin values degrade to the bare surface); this
// bar used to carry its own looser copy of it, and two hand-mirrored copies
// of one security allowlist is exactly one too many.
function navAuthHref(target: AuthSurface, pathname: string, search: string): string {
  return authHrefWithFrom(target, search ? `${pathname}?${search}` : pathname);
}

interface AuthCtaViewProps {
  loginHref: string;
  registerHref: string;
  classes: AuthCtaClasses;
}

// Presentational half of the logged-out chrome, split out so the identical
// markup can render on both sides of the Suspense boundary below.
function AuthCtaView({ loginHref, registerHref, classes }: AuthCtaViewProps) {
  const { t } = useLang();
  return (
    <>
      <Link href={loginHref} prefetch={false} className={classes.login}>
        {t("nav.login")}
      </Link>
      <Link href={registerHref} prefetch={false} className={classes.register}>
        {t("nav.register")}
      </Link>
    </>
  );
}

// useSearchParams() lives HERE, behind its own <Suspense>, and not in Navbar:
// Navbar renders from the root layout and /anime/* is prerendered (ISR), and
// an unwrapped useSearchParams() anywhere in a prerendered tree fails the
// production build with "Missing Suspense boundary with useSearchParams".
// The fallback is the same two links minus the ?from= round-trip, so the
// prerendered HTML is complete and the client swap is invisible.
function AuthCtaWithFrom({ classes }: { classes: AuthCtaClasses }) {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams()?.toString() ?? "";
  return (
    <AuthCtaView
      loginHref={navAuthHref("/login", pathname, search)}
      registerHref={navAuthHref("/register", pathname, search)}
      classes={classes}
    />
  );
}

/** 登录 + 注册, carrying ?from= so signing in returns the reader here. */
export default function NavAuthCta({ classes }: { classes: AuthCtaClasses }) {
  return (
    <Suspense fallback={<AuthCtaView loginHref="/login" registerHref="/register" classes={classes} />}>
      <AuthCtaWithFrom classes={classes} />
    </Suspense>
  );
}
