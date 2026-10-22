// The settings page's requests. Each resolves to an outcome rather than
// throwing, with the server's own message on failure (settingsErrorMessage)
// or a fallback in the reader's language — the page shows it in a toast.
//
// No toast here and no React: the tests import this module, and bun:test has
// no DOM for react-hot-toast to load into (see testImportHygiene.test.ts).

import { authFetch } from "@/lib/authFetch";
import type { Lang } from "@/lib/i18n/lang";
import {
  envelopeData,
  readSavedAccount,
  revokedCount,
  settingsErrorMessage,
  type SavedAccount,
} from "./settingsState";

/**
 * A request's result. Flat rather than a union discriminated on `ok`: this
 * project compiles without strictNullChecks, where a boolean discriminant
 * does not narrow (same shape as lib/authForm's SubmitResult).
 */
export interface Outcome<T> {
  ok: boolean;
  /** What the request produced; null when it failed. */
  value: T | null;
  /** The message to show when it failed; "" when it worked. */
  error: string;
}

type FailureKind = "save" | "send" | "signOut";

// Takes the language rather than an is-Chinese boolean. Every string here is
// a fallback for a failed request, which is exactly the path nobody re-reads —
// a boolean would have silently handed a third language the English copy.
const FALLBACK: Record<Lang, Record<FailureKind | "network", string>> = {
  zh: { save: "保存失败", send: "发送失败", signOut: "退出失败", network: "网络错误" },
  en: { save: "Save failed", send: "Could not send", signOut: "Could not sign out", network: "Network error" },
  "zh-Hant": { save: "儲存失敗", send: "傳送失敗", signOut: "登出失敗", network: "網路錯誤" },
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function succeeded<T>(value: T): Outcome<T> {
  return { ok: true, value, error: "" };
}

function failed<T>(error: string): Outcome<T> {
  return { ok: false, value: null, error };
}

async function request<T>(
  url: string,
  init: RequestInit,
  lang: Lang,
  failure: FailureKind,
  read: (data: unknown) => T,
): Promise<Outcome<T>> {
  try {
    // skipRedirectOnFailure: a request that fails stays on this page with a
    // message, rather than navigating away mid-edit.
    const response = await authFetch(url, { ...init, skipRedirectOnFailure: true });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return succeeded(read(envelopeData(body)));
    return failed(settingsErrorMessage(body, FALLBACK[lang][failure]));
  } catch {
    return failed(FALLBACK[lang].network);
  }
}

const nothing = (): null => null;

/**
 * PATCH /api/auth/me with any of { username, avatarUrl, backdropAnilistId,
 * isPublic }. On success, what the server now holds — null if its answer
 * could not be read, which the caller treats as "saved as sent".
 */
export function patchMe(body: Record<string, unknown>, lang: Lang): Promise<Outcome<SavedAccount | null>> {
  return request(
    "/api/auth/me",
    { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) },
    lang,
    "save",
    readSavedAccount,
  );
}

/** POST /api/auth/forgot-password: the same email link the login page sends. */
export function sendPasswordLink(email: string, lang: Lang): Promise<Outcome<null>> {
  return request(
    "/api/auth/forgot-password",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email }) },
    lang,
    "send",
    nothing,
  );
}

/** DELETE /api/auth/sessions/{id}: sign one other device out. */
export function endSession(id: string, lang: Lang): Promise<Outcome<null>> {
  return request(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, lang, "signOut", nothing);
}

/**
 * DELETE /api/auth/sessions: sign out every session but this one. Resolves to
 * how many the server ended, or `expected` if it did not say.
 */
export function endOtherSessions(expected: number, lang: Lang): Promise<Outcome<number>> {
  return request("/api/auth/sessions", { method: "DELETE" }, lang, "signOut", (data) =>
    revokedCount(data, expected),
  );
}
