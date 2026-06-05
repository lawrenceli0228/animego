"use client";

import Link from "next/link";
import { useState, type CSSProperties, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { translateErrorMessage } from "@/lib/authForm";
import { authFormStyles } from "@/lib/authFormStyles";
import { submitLogin } from "../_lib/loginFlow";
import { redirectAfterAuth } from "@/lib/authRedirect";

interface LoginFormProps {
  /**
   * Server-sanitized post-login target. page.tsx runs the URL through
   * sanitizeFromParam so this is always a same-origin path starting
   * with "/" (and never "/login").
   */
  from: string;
  dict: Dict;
}

interface FormState {
  email: string;
  password: string;
}

// LoginForm-specific bits — forgot-password row sits between the
// password input and the error region. The rest of the inline styles
// live in @/lib/authFormStyles.
const styles = {
  ...authFormStyles,
  forgotRow: {
    textAlign: "right",
    marginTop: -8,
    marginBottom: 16,
  } as CSSProperties,
  forgotLink: {
    color: "#0a84ff",
    fontSize: 13,
    fontWeight: 500,
    textDecoration: "none",
  } as CSSProperties,
};

export default function LoginForm({ from, dict }: LoginFormProps) {
  const [form, setForm] = useState<FormState>({ email: "", password: "" });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<"email" | "password" | null>(null);

  const t = dict.login;
  // `loading` stays true through the post-success full navigation (the page
  // unloads), keeping the submit button disabled until we leave.
  const busy = loading;

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
    setLoading(true);
    try {
      const result = await submitLogin(form.email, form.password);
      if (result.ok) {
        // Full navigation, not a soft router.replace — see redirectAfterAuth
        // (the Navbar is a client island; a soft nav updates it only racily, so
        // the user lands "logged out" until a manual refresh). `from` is
        // server-sanitized to a same-origin path.
        redirectAfterAuth(from);
      } else {
        // Backend response.error.message is already localized on the
        // server (legacy Express returns Chinese for INVALID_CREDENTIALS);
        // fall back to dict.login.fail when the message is missing or
        // generic. translateErrorMessage handles the dict.errors lookup
        // + prototype-key safety + 200-char cap.
        const translated = translateErrorMessage(result.message, dict);
        setError(translated || t.fail);
      }
    } finally {
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
          <label style={styles.label} htmlFor="login-email">
            {t.email}
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={updateField("email")}
            onFocus={() => setFocused("email")}
            onBlur={() => setFocused(null)}
            required
            disabled={busy}
            style={styles.input(focused === "email")}
          />

          <label style={styles.label} htmlFor="login-password">
            {t.password}
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={updateField("password")}
            onFocus={() => setFocused("password")}
            onBlur={() => setFocused(null)}
            required
            disabled={busy}
            style={styles.input(focused === "password")}
          />

          <div style={styles.forgotRow}>
            <Link href="/forgot-password" prefetch={false} style={styles.forgotLink}>
              {t.forgotPassword}
            </Link>
          </div>

          <p role="alert" aria-live="polite" style={styles.error}>
            {error}
          </p>

          <button type="submit" disabled={busy} style={styles.submit(busy)}>
            {busy ? t.submitting : t.submit}
          </button>
        </form>

        <p style={styles.footer}>
          {t.noAccount}{" "}
          <Link href="/register" prefetch={false} style={styles.footerLink}>
            {t.registerLink}
          </Link>
        </p>
      </div>
    </div>
  );
}

