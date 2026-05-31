"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { translateErrorMessage } from "@/lib/authForm";
import { authFormStyles } from "@/lib/authFormStyles";
import { submitResetPassword } from "../_lib/resetPasswordFlow";

interface ResetPasswordFormProps {
  token: string;
  dict: Dict;
}

interface FormState {
  password: string;
  confirm: string;
}

type FieldKey = keyof FormState;

// Mirrors /register — backend rule is >= 6 (see auth.controller.js:174).
const PASSWORD_MIN_LENGTH = 6;

const styles = authFormStyles;

export default function ResetPasswordForm({ token, dict }: ResetPasswordFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({ password: "", confirm: "" });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [focused, setFocused] = useState<FieldKey | null>(null);

  const t = dict.resetPassword;
  const busy = loading || navigating;

  function updateField<K extends keyof FormState>(key: K) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setForm((prev) => ({ ...prev, [key]: next }));
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");

    // Client-side mismatch guard — backend doesn't compare these two
    // fields (only the new password is sent), so the check has to live
    // here. Same shape as /register's pwd-length guard: fail fast,
    // skip the network round-trip.
    if (form.password !== form.confirm) {
      setError(t.mismatch);
      return;
    }

    setLoading(true);
    const result = await submitResetPassword(token, form.password);
    if (result.ok) {
      // Backend just invalidated user.refreshToken — every existing
      // session is dead. router.replace + router.refresh sends the
      // user to /login and re-runs the root layout's session probe
      // so Navbar drops any stale logged-in state.
      //
      // Intentionally NOT resetting `loading` here. The form is about
      // to unmount when the transition commits navigation; clearing
      // loading in a finally block would create a one-render gap
      // where neither `loading` nor `navigating` is true, briefly
      // re-enabling the disabled submit button.
      startTransition(() => {
        router.replace("/login");
        router.refresh();
      });
    } else {
      const translated = translateErrorMessage(result.message, dict);
      setError(translated || t.invalidToken);
      setLoading(false);
    }
  }

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.title}>{t.title}</h1>
          <p style={styles.subtitle}>{t.subtitle}</p>
        </header>

        <form onSubmit={handleSubmit} noValidate>
          <label style={styles.label} htmlFor="reset-password">
            {t.password}
          </label>
          <input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={updateField("password")}
            onFocus={() => setFocused("password")}
            onBlur={() => setFocused(null)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={busy}
            style={styles.input(focused === "password")}
          />

          <label style={styles.label} htmlFor="reset-confirm">
            {t.confirm}
          </label>
          <input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={updateField("confirm")}
            onFocus={() => setFocused("confirm")}
            onBlur={() => setFocused(null)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={busy}
            style={styles.input(focused === "confirm")}
          />

          <p role="alert" aria-live="polite" style={styles.error}>
            {error}
          </p>

          <button type="submit" disabled={busy} style={styles.submit(busy)}>
            {busy ? t.submitting : t.submit}
          </button>
        </form>

        <p style={styles.footer}>
          <Link href="/login" prefetch={false} style={styles.footerLink}>
            {t.backToLogin}
          </Link>
        </p>
      </div>
    </div>
  );
}
