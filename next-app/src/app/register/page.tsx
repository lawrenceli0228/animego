import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { getDict } from "@/lib/i18n";
import { sanitizeFromParam } from "@/lib/authForm";
import RegisterForm from "./_components/RegisterForm";

// P9 — Next.js port of legacy client/src/pages/RegisterPage.jsx.
// Same shape as /login (server-side already-authed bypass + dynamic
// rendering driven by ?from= and the session cookie).
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  return {
    title: dict.register.pageTitle,
    // Auth pages are off-index — see /login for the same robots posture.
    robots: { index: false, follow: false },
  };
}

interface RegisterPageProps {
  searchParams: Promise<{ from?: string | string[] }>;
}

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const [{ from: rawFrom }, dict, jar] = await Promise.all([
    searchParams,
    getDict(),
    cookies(),
  ]);
  const from = sanitizeFromParam(rawFrom);

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
