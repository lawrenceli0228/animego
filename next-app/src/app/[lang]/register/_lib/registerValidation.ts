// Client-side field rules for /register, kept as pure functions so they can be
// tested without a renderer (this repo has no React Testing Library — see the
// other *.test.ts files for the convention).
//
// Why a confirm field exists here at all, when modern guidance often says to
// drop it in favour of a reveal toggle: on this site a mistyped password is
// close to unrecoverable. Recovery runs through SendPasswordReset over Gmail
// SMTP, and 79.6% of registered addresses are @qq.com — a sender/recipient
// pair whose deliverability is poor and, over bare net/smtp, not even
// observable (bounces return to the sending mailbox, not to us). So the
// generic "the reset flow will catch it" assumption does not hold, and the
// cost of one extra field is much smaller than the cost of an account nobody
// can ever sign into. We ship both the confirm field and the reveal toggle.
//
// The backend enforces the length rule independently (registerRules requires
// >= 6 and answers "密码至少 6 位"); this is the faster, offline-capable copy
// of the same constraint. The match rule is client-only by construction — the
// server never sees the second field.

/** Minimum accepted password length. Mirrors the backend's registerRules. */
export const PASSWORD_MIN_LENGTH = 6;

/**
 * Which register-dictionary key describes what is wrong, or null when the
 * fields are acceptable.
 *
 * Returning a key rather than a message keeps this module free of `dict`, so
 * it stays a pure string-in/string-out function and the caller owns
 * localisation.
 */
export type RegisterFieldErrorKey = "pwdTooShort" | "pwdMismatch";

export function validateRegisterFields(
  password: string,
  confirmPassword: string,
): RegisterFieldErrorKey | null {
  // Length first: when someone types "abc" twice, "too short" is the useful
  // message and "they match" is not worth saying. Reporting the mismatch
  // first would make them fix the confirm field and then hit a second,
  // different error on the next submit.
  if (password.length < PASSWORD_MIN_LENGTH) return "pwdTooShort";
  if (password !== confirmPassword) return "pwdMismatch";
  return null;
}

/**
 * Whether to mark the confirm input `aria-invalid` while the user is still
 * filling the form.
 *
 * Deliberately quiet until the field has content: flagging an empty confirm
 * box the moment the first password gains a character would put every visitor
 * in an error state before they had a chance to do anything wrong. It also
 * stays quiet while the confirm value is a strict prefix of the password,
 * which is what every correct entry looks like mid-typing.
 */
export function isConfirmMismatchVisible(
  password: string,
  confirmPassword: string,
): boolean {
  if (confirmPassword.length === 0) return false;
  if (password.startsWith(confirmPassword)) return false;
  return password !== confirmPassword;
}
