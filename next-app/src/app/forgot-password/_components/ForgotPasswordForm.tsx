"use client";

import Link from "next/link";
import { useState, type CSSProperties, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { translateErrorMessage } from "@/lib/authForm";
import { authFormStyles } from "@/lib/authFormStyles";
import { submitForgotPassword } from "../_lib/forgotPasswordFlow";

interface ForgotPasswordFormProps {
  dict: Dict;
}

// ForgotPasswordForm-specific bits — the post-submit "sent" view
// replaces the form with a glyph + success copy + back-to-login link.
// Other inline styles live in @/lib/authFormStyles.
const styles = {
  ...authFormStyles,
  sentWrap: { textAlign: "center" } as CSSProperties,
  sentGlyph: { fontSize: 48, marginBottom: 16 } as CSSProperties,
  sentMessage: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 14,
    lineHeight: 1.7,
    marginBottom: 24,
  } as CSSProperties,
  sentLink: {
    color: "#0a84ff",
    fontWeight: 600,
    fontSize: 14,
    textDecoration: "none",
  } as CSSProperties,
};

export default function ForgotPasswordForm({ dict }: ForgotPasswordFormProps) {
  const [email, setEmail] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<boolean>(false);
  const [sent, setSent] = useState<boolean>(false);

  const t = dict.forgotPassword;
  const busy = loading;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setLoading(true);
    try {
      const result = await submitForgotPassword(email);
      if (result.ok) {
        // Backend always returns 200 regardless of whether the email
        // exists (privacy: prevents user enumeration), so a successful
        // response just swaps the form for the "check your email" view.
        setSent(true);
      } else {
        // Only network failures and 429 from authLimiter reach this
        // branch. translateErrorMessage handles dict.errors lookup +
        // 200-char cap; fall back to dict.forgotPassword.fail when the
        // backend gives us nothing useful (or a status-only string).
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

        {sent ? (
          <div style={styles.sentWrap}>
            <div style={styles.sentGlyph} aria-hidden="true">
              ✉️
            </div>
            <p style={styles.sentMessage}>{t.success}</p>
            <Link href="/login" prefetch={false} style={styles.sentLink}>
              {t.backToLogin}
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <label style={styles.label} htmlFor="forgot-email">
              {t.email}
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              required
              disabled={busy}
              style={styles.input(focused)}
            />

            <p role="alert" aria-live="polite" style={styles.error}>
              {error}
            </p>

            <button type="submit" disabled={busy} style={styles.submit(busy)}>
              {busy ? t.submitting : t.submit}
            </button>

            <p style={styles.footer}>
              <Link href="/login" prefetch={false} style={styles.footerLink}>
                {t.backToLogin}
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
