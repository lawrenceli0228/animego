import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { sanitizeFromParam } from "@/lib/authForm";
import RegisterForm from "./_components/RegisterForm";

// P9 — Next.js port of legacy client/src/pages/RegisterPage.jsx.
// Same shape as /login (server-side already-authed bypass + dynamic
// rendering driven by ?from= and the session cookie).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/register">): Promise<Metadata> {
  const { dict } = await resolveLocale(params);
  return {
    title: dict.register.pageTitle,
    // Auth pages are off-index — see /login for the same robots posture.
    robots: { index: false, follow: false },
  };
}

interface RegisterPageProps {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}

export default async function RegisterPage({ params, searchParams }: RegisterPageProps) {
  const [{ from: rawFrom }, { locale, dict }, jar] = await Promise.all([
    searchParams,
    resolveLocale(params),
    cookies(),
  ]);
  const from = sanitizeFromParam(rawFrom, localizePath("/", locale));

  // Already-authed bypass: same intentional asymmetry vs proxy.ts as
  // /login. proxy.ts fails closed on missing JWT_SECRET; this page
  // falls through and renders the form so the only escape hatch from a
  // misconfigured deploy stays available.
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
    if (valid) redirect(from);
  }

  return <RegisterForm from={from} dict={dict} />;
}
