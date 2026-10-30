"use client";

// Client Component for the admin "create user" form, shown under the user
// list's 创建用户 button (UsersSection owns the open/closed state).
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
import s from "./users.module.css";

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
    <button type="submit" disabled={pending} className={s.primary}>
      {pending ? tFn("admin.creatingUser") : tFn("admin.createUser")}
    </button>
  );
}

interface CreateUserFormProps {
  /** The wrapper's id, for the toggle's aria-controls. */
  id?: string;
  /** After a successful create, so the list can fetch the page again. */
  onCreated?: (username: string) => void;
}

export function CreateUserForm({ id, onCreated }: CreateUserFormProps) {
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
      onCreated?.(created.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.createFailed"));
    }
  };

  return (
    <div id={id} className={s.createWrap}>
      <form action={onSubmit} className={s.createForm}>
        <input
          type="text"
          name="username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder={t("admin.usernamePlaceholder")}
          autoComplete="off"
          className={s.input}
          aria-label={t("admin.usernameLabel")}
        />
        <input
          type="email"
          name="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder={t("admin.emailPlaceholder")}
          autoComplete="off"
          className={s.input}
          aria-label={t("admin.emailLabel")}
        />
        <input
          type="password"
          name="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder={t("admin.passwordPlaceholder")}
          autoComplete="new-password"
          className={`${s.input} ${s.inputNarrow}`}
          aria-label={t("admin.passwordLabel")}
        />
        <SubmitButton tFn={t} />
      </form>
      {error && (
        <p role="alert" className={s.formError}>
          {error}
        </p>
      )}
      {success && (
        <p role="status" className={s.formOk}>
          {success}
        </p>
      )}
    </div>
  );
}
