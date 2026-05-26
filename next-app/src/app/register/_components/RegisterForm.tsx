"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type CSSProperties, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { translateErrorMessage } from "@/lib/authForm";
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

const styles = {
  shell: {
    minHeight: "calc(100vh - 56px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
  } as CSSProperties,
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#1c1c1e",
    border: "1px solid #38383a",
    borderRadius: 16,
    padding: 40,
    boxShadow: "0 16px 48px rgba(0,0,0,0.60)",
  } as CSSProperties,
  header: { textAlign: "center", marginBottom: 32 } as CSSProperties,
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 28,
    color: "#ffffff",
    marginBottom: 8,
  } as CSSProperties,
  subtitle: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 14,
  } as CSSProperties,
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "rgba(235,235,245,0.60)",
    marginBottom: 6,
  } as CSSProperties,
  input: (focused: boolean): CSSProperties => ({
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    background: "#2c2c2e",
    border: `1px solid ${focused ? "#0a84ff" : "#38383a"}`,
    boxShadow: focused ? "0 0 0 3px rgba(10,132,255,0.25)" : "none",
    color: "#ffffff",
    fontSize: 14,
    outline: "none",
    marginBottom: 16,
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxSizing: "border-box",
  }),
  error: {
    color: "#ff453a",
    fontSize: 13,
    marginBottom: 12,
    textAlign: "center",
    minHeight: 18,
  } as CSSProperties,
  submit: (busy: boolean): CSSProperties => ({
    width: "100%",
    padding: 12,
    background: "#0a84ff",
    border: "none",
    borderRadius: 10,
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "'Sora', sans-serif",
    opacity: busy ? 0.7 : 1,
    transition: "opacity 0.15s",
  }),
  footer: {
    textAlign: "center",
    marginTop: 20,
    fontSize: 14,
    color: "rgba(235,235,245,0.55)",
  } as CSSProperties,
  footerLink: {
    color: "#0a84ff",
    fontWeight: 600,
    textDecoration: "none",
  } as CSSProperties,
};

export default function RegisterForm({ from, dict }: RegisterFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({ username: "", email: "", password: "" });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [focused, setFocused] = useState<FieldKey | null>(null);

  const t = dict.register;
  const busy = loading || navigating;

  function updateField(key: FieldKey) {
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

