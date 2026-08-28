import type { Metadata } from "next";
import { resolveLocale } from "@/lib/i18n/route";
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
//     clear the user's refresh-token columns on success, so every other
//     session loses its refresh credential — though a session holding an
//     unexpired access JWT keeps working until it expires (15m default;
//     access tokens are stateless and cannot be revoked). The eventual
//     flow is still "reset → re-login", just not instantly elsewhere.
//   - No server-side pre-check of the token. Pre-validation would
//     double the backend load and open a TOCTOU window between the
//     check and the POST. The form submit hits the same endpoint that
//     would have been used to validate; INVALID_TOKEN surfaces inline.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/reset-password/[token]">): Promise<Metadata> {
  const { dict } = await resolveLocale(params);
  return {
    title: dict.resetPassword.pageTitle,
    // Reset links are private per-user surfaces — keep them out of indexes.
    robots: { index: false, follow: false },
  };
}

interface ResetPasswordPageProps {
  // Next 16 makes both `params` and `searchParams` Promises (see
  // node_modules/next/dist/docs/...). Mirror the /anime/[id] shape.
  params: Promise<{ lang: string; token: string }>;
}

export default async function ResetPasswordPage({ params }: ResetPasswordPageProps) {
  const [{ token }, { dict }] = await Promise.all([params, resolveLocale(params)]);

  // The token serializes into the RSC flight payload that ships in the
  // initial HTML. Acceptable: the same token is already visible in the
  // user's address bar + browser history. It is single-use, 1h TTL,
  // and never logged or echoed into DOM text. Documented exposure
  // surface, not a new leak.
  return <ResetPasswordForm token={token} dict={dict} />;
}
