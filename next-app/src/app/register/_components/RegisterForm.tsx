"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { translateErrorMessage } from "@/lib/authForm";
import { authFormStyles } from "@/lib/authFormStyles";
import { submitRegister } from "../_lib/registerFlow";

interface RegisterFormProps {
  from: string;
  dict: Dict;
}

interface FormState {
  username: string;
  email: string;
  password: string;
}

type FieldKey = keyof FormState;

// Min-length rule lives on /register only — /login intentionally
// accepts any non-empty password because existing accounts may predate
// any future tightening of the rule. Backend mirrors this asymmetry
// (registerRules requires >= 6, loginRules does not).
const PASSWORD_MIN_LENGTH = 6;

const styles = authFormStyles;

export default function RegisterForm({ from, dict }: RegisterFormProps) {
  const [form, setForm] = useState<FormState>({ username: "", email: "", password: "" });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<FieldKey | null>(null);

  const t = dict.register;
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

    // Client-side guard for password length. Backend validates the
    // same constraint and returns "密码至少 6 位", so this is just a
    // faster + offline-capable check matching the legacy SPA's UX.
    if (form.password.length < PASSWORD_MIN_LENGTH) {
      setError(t.pwdTooShort);
      return;
    }

    setLoading(true);
    try {
      const result = await submitRegister(form.username, form.email, form.password);
      if (result.ok) {
        // Full navigation (NOT router.replace) — same reasoning as /login: the
        // Navbar is a client island that probes auth in its own effect, so a
        // soft replace updates it only racily. A full nav lands the new account
        // on `from` with cookies committed, so the nav reliably shows logged-in.
        window.location.replace(from);
      } else {
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
          <label style={styles.label} htmlFor="register-username">
            {t.username}
          </label>
          <input
            id="register-username"
            type="text"
            autoComplete="username"
            value={form.username}
            onChange={updateField("username")}
            onFocus={() => setFocused("username")}
            onBlur={() => setFocused(null)}
            required
            disabled={busy}
            style={styles.input(focused === "username")}
          />

          <label style={styles.label} htmlFor="register-email">
            {t.email}
          </label>
          <input
            id="register-email"
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

          <label style={styles.label} htmlFor="register-password">
            {t.password}
          </label>
          <input
            id="register-password"
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

          <p role="alert" aria-live="polite" style={styles.error}>
            {error}
          </p>

          <button type="submit" disabled={busy} style={styles.submit(busy)}>
            {busy ? t.submitting : t.submit}
          </button>
        </form>

        <p style={styles.footer}>
          {t.hasAccount}{" "}
          <Link href="/login" prefetch={false} style={styles.footerLink}>
            {t.loginLink}
          </Link>
        </p>
      </div>
    </div>
  );
}

