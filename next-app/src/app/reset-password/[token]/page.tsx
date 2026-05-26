import type { Metadata } from "next";
import { getDict } from "@/lib/i18n";
import ResetPasswordForm from "./_components/ResetPasswordForm";

// P9 — Next.js port of legacy client/src/pages/ResetPasswordPage.jsx.
// Dynamic segment `[token]` carries the per-link reset secret minted by
// the /forgot-password flow (stored in user.resetPasswordToken, 1h TTL).
//
// Deliberate departures from /login + /register:
//   - No already-authed bypass via session cookie. Legacy didn't gate
//     this surface, and a logged-in user holding a valid reset link
//     SHOULD still be able to reset (e.g. recovering an account from
//     another device while signed in elsewhere). The backend will also
//     invalidate the user's refreshToken on success, killing every
//     other session — so the eventual flow is "reset → re-login".
//   - No server-side pre-check of the token. Pre-validation would
//     double the backend load and open a TOCTOU window between the
//     check and the POST. The form submit hits the same endpoint that
//     would have been used to validate; INVALID_TOKEN surfaces inline.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "重置密码",
  // Reset links are private per-user surfaces — keep them out of indexes.
  robots: { index: false, follow: false },
};

interface ResetPasswordPageProps {
  // Next 16 makes both `params` and `searchParams` Promises (see
  // node_modules/next/dist/docs/...). Mirror the /anime/[id] shape.
  params: Promise<{ token: string }>;
}

export default async function ResetPasswordPage({ params }: ResetPasswordPageProps) {
  const [{ token }, dict] = await Promise.all([params, getDict()]);

  // The token serializes into the RSC flight payload that ships in the
  // initial HTML. Acceptable: the same token is already visible in the
  // user's address bar + browser history. It is single-use, 1h TTL,
  // and never logged or echoed into DOM text. Documented exposure
  // surface, not a new leak.
  return <ResetPasswordForm token={token} dict={dict} />;
}
