import type { Metadata } from "next";
import { getDict } from "@/lib/i18n";
import ForgotPasswordForm from "./_components/ForgotPasswordForm";

// P9 — Next.js port of legacy client/src/pages/ForgotPasswordPage.jsx.
//
// Unlike /login + /register this surface intentionally has no ?from=
// round-trip and no already-authed bypass: even signed-in users may
// legitimately want to start a password reset, and the form never
// redirects on success (it swaps to a "check your email" view in
// place). Dynamic rendering is still required because dict resolution
// reads the per-request `lang` cookie.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  return {
    title: dict.forgotPassword.pageTitle,
    // Auth surfaces stay off-index — see /login for the same posture.
    robots: { index: false, follow: false },
  };
}

export default async function ForgotPasswordPage() {
  const dict = await getDict();
  return <ForgotPasswordForm dict={dict} />;
}
