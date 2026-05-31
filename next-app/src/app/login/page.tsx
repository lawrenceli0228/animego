import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { getDict } from "@/lib/i18n";
import { sanitizeFromParam } from "@/lib/authForm";
import LoginForm from "./_components/LoginForm";

// P9 — Next.js port of legacy client/src/pages/LoginPage.jsx.
//
// The page is dynamic (depends on per-request session cookie and the
// ?from= round-trip), so static prerender is impossible by construction.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  return {
    title: dict.login.pageTitle,
    // Keep auth pages out of the index — they have no organic value and
    // crawlers shouldn't be the ones discovering /login.
    robots: { index: false, follow: false },
  };
}

interface LoginPageProps {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ from?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [{ from: rawFrom }, dict, jar] = await Promise.all([
    searchParams,
    getDict(),
    cookies(),
  ]);
  const from = sanitizeFromParam(rawFrom);

  // Already-authed bypass: skip the form entirely when the request
  // carries a valid session cookie. Legacy SPA did this in-component
  // via `if (user) return <Navigate to="/" replace />`; doing it
  // server-side means logged-in users never see the form flash.
  //
  // Intentional asymmetry vs proxy.ts on missing JWT_SECRET: proxy.ts
  // 500s (fail closed for gated routes); this page falls through and
  // renders the form (fail open for the login surface). Rationale —
  // the login form is the only escape hatch from a misconfigured
  // deploy, and proxy.ts already rejects every gated request, so an
  // authed user can't escalate via this branch. The backend POST
  // would also reject the credential under the same misconfig, so
  // showing the form is harmless and clearer than a blank 500.
  const token = jar.get("session")?.value;
  const secret = process.env.JWT_SECRET;
  if (token && secret) {
    let valid = false;
    try {
      jwt.verify(token, secret);
      valid = true;
    } catch {
      /* expired / tampered — fall through and render the form */
    }
    if (valid) redirect(from); // throws NEXT_REDIRECT, must be outside try
  }

  return <LoginForm from={from} dict={dict} />;
}
