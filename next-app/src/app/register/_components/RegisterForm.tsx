"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
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
  const router = useRouter();
  const [form, setForm] = useState<FormState>({ username: "", email: "", password: "" });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [focused, setFocused] = useState<FieldKey | null>(null);

  const t = dict.register;
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
        // Cookies committed before the promise resolves (same invariant
        // as /login). router.replace + router.refresh re-runs the root
        // layout's /api/auth/me fetch so Navbar flips to logged-in
        // CTAs and the new account lands on `from`.
        startTransition(() => {
          router.replace(from);
          router.refresh();
        });
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

