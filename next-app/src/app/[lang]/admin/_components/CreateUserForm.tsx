"use client";

// Client Component for the admin "create user" form.
//
// Three controlled inputs (username / email / password) + submit. The
// form action is a Server Action so React's <form action={...}>
// progressive-enhancement story works -- a JS-disabled browser still
// POSTs the form, the action still runs, and revalidation still fires.
// useFormStatus provides the pending UI inside the submit button.
//
// Validation runs client-side as a first-line guard against typos; the
// Server Action runs the same checks again before touching go-api, so
// these rules are defense-in-depth, not authoritative.

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { createAdminUser } from "../_actions/users";
import { useLang } from "@/lib/lang-client";

const SUCCESS_MS = 3000;

interface FormState {
  username: string;
  email: string;
  password: string;
}

const EMPTY_FORM: FormState = { username: "", email: "", password: "" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(form: FormState, tFn: (key: string) => string): string | null {
  const username = form.username.trim();
  if (username.length < 3 || username.length > 50) {
    return tFn("admin.usernameMinMax")
      .replace("{{min}}", "3")
      .replace("{{max}}", "50");
  }
  const email = form.email.trim();
  if (!EMAIL_RE.test(email)) {
    return tFn("admin.invalidEmail");
  }
  if (form.password.length < 6) {
    return tFn("admin.passwordMinLen").replace("{{min}}", "6");
  }
  return null;
}

function SubmitButton({ tFn }: { tFn: (key: string) => string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={pending ? { ...styles.submitBtn, ...styles.submitDisabled } : styles.submitBtn}
    >
      {pending ? tFn("admin.creatingUser") : tFn("admin.createUser")}
    </button>
  );
}

export function CreateUserForm() {
  const { t } = useLang();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the auto-fade timer on unmount so the state setter doesn't
  // fire against an unmounted component (React warning) and so the
  // timer doesn't leak across mount/unmount cycles.
  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    [],
  );

  const onSubmit = async () => {
    setError(null);
    const validationError = validate(form, t);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      const created = await createAdminUser({
        username: form.username.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      setForm(EMPTY_FORM);
      setSuccess(t("admin.createdUser").replace("{{username}}", created.username));
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => {
        setSuccess(null);
        successTimerRef.current = null;
      }, SUCCESS_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.createFailed"));
    }
  };

  return (
    <div style={styles.wrap}>
      <form action={onSubmit} style={styles.form}>
        <input
          type="text"
          name="username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder={t("admin.usernamePlaceholder")}
          autoComplete="off"
          style={styles.input}
          aria-label={t("admin.usernameLabel")}
        />
        <input
          type="email"
          name="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder={t("admin.emailPlaceholder")}
          autoComplete="off"
          style={styles.input}
          aria-label={t("admin.emailLabel")}
        />
        <input
          type="password"
          name="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder={t("admin.passwordPlaceholder")}
          autoComplete="new-password"
          style={{ ...styles.input, ...styles.passwordInput }}
          aria-label={t("admin.passwordLabel")}
        />
        <SubmitButton tFn={t} />
      </form>
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
      {success && (
        <p role="status" style={styles.success}>
          {success}
        </p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
    padding: "16px 18px",
    marginBottom: 20,
  },
  form: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  input: {
    flex: "1 1 200px",
    minWidth: 160,
    padding: "9px 12px",
    borderRadius: 6,
    border: "1px solid #2a2a38",
    background: "#0d0d14",
    color: "#e7e7ef",
    fontSize: 13,
    outline: "none",
  },
  passwordInput: {
    flex: "0 1 200px",
    maxWidth: 220,
  },
  submitBtn: {
    padding: "9px 18px",
    borderRadius: 6,
    border: "1px solid #3b82f6",
    background: "#3b82f6",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  submitDisabled: {
    background: "#1f2a44",
    borderColor: "#1f2a44",
    color: "#7c7c8c",
    cursor: "not-allowed",
  },
  error: {
    margin: "10px 0 0",
    fontSize: 12,
    color: "#ff453a",
  },
  success: {
    margin: "10px 0 0",
    fontSize: 12,
    color: "#30d158",
  },
};
