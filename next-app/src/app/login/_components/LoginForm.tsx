"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type CSSProperties, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { submitLogin } from "../_lib/loginFlow";

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

export default function LoginForm({ from, dict }: LoginFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({ email: "", password: "" });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [focused, setFocused] = useState<"email" | "password" | null>(null);

  const t = dict.login;
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
    setLoading(true);
    try {
      const result = await submitLogin(form.email, form.password);
      if (result.ok) {
        // Navigate to the sanitized `from`, then refresh so the root
        // layout's /api/auth/me fetch re-runs and Navbar flips from
        // anonymous to logged-in CTAs.
        //
        // No race on router.refresh() reading a stale cookie: the
        // browser commits Set-Cookie from /api/auth/login before the
        // fetch promise resolves, so by the time this branch runs the
        // session cookie is already in the jar and the RSC refetch
        // attaches it.
        startTransition(() => {
          router.replace(from);
          router.refresh();
        });
      } else {
        // Backend response.error.message is already localized on the
        // server (legacy Express returns Chinese for INVALID_CREDENTIALS);
        // fall back to dict.login.fail when the message is missing or
        // generic.
        const translated = translateMessage(result.message, dict);
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

// Best-effort lookup of an English error string in dict.errors. The
// legacy SPA does the same thing via utils/errorDisplay — backend
// occasionally returns English (validation messages) and dict.errors
// is keyed by exact English wording.
//
// dict.errors is always defined on the zh shape (Dict = typeof zh);
// the cast to Record<string, string> only widens the literal-key
// object to allow dynamic-key access. Result is capped at 200 chars
// so a misbehaving backend can't push a wall of text into the inline
// error region.
const MAX_ERROR_LENGTH = 200;
function translateMessage(message: string, dict: Dict): string {
  const map = dict.errors as Record<string, string>;
  const translated = map[message];
  const out =
    typeof translated === "string" && translated.length > 0 ? translated : message;
  return out.slice(0, MAX_ERROR_LENGTH);
}
