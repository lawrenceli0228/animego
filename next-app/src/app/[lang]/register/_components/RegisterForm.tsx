"use client";

import Link from "@/components/ui/LocaleLink";
import { useState, type FormEvent } from "react";
import type { Dict } from "@/lib/i18n";
import { translateErrorMessage } from "@/lib/authForm";
import { authFormStyles } from "@/lib/authFormStyles";
import { submitRegister } from "../_lib/registerFlow";
import {
  PASSWORD_MIN_LENGTH,
  isConfirmMismatchVisible,
  validateRegisterFields,
} from "../_lib/registerValidation";
import { redirectAfterAuth } from "@/lib/authRedirect";

interface RegisterFormProps {
  from: string;
  dict: Dict;
}

interface FormState {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

type FieldKey = keyof FormState;

const styles = authFormStyles;

// Inline SVG rather than an emoji: 👁/🙈 render at wildly different sizes and
// weights per platform (and as full-colour glyphs on macOS), which reads as
// unfinished next to the flat UI around it. These are the Feather eye /
// eye-off paths — the shape users already recognise from every other login
// form — stroked in currentColor so the button's hover state drives them.
// Inline because the CSP blocks external asset hosts and this is 2 icons.
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export default function RegisterForm({ from, dict }: RegisterFormProps) {
  const [form, setForm] = useState<FormState>({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<FieldKey | null>(null);
  // One toggle per field rather than a single shared one: the two boxes exist
  // precisely to be compared, and a reader who reveals only the confirm box
  // is doing exactly the check the field is for.
  const [revealed, setRevealed] = useState({ password: false, confirmPassword: false });
  const [hoveredReveal, setHoveredReveal] = useState<"password" | "confirmPassword" | null>(null);

  const t = dict.register;
  // `loading` stays true through the post-success full navigation (the page
  // unloads), keeping the submit button disabled until we leave.
  const busy = loading;

  const mismatchVisible = isConfirmMismatchVisible(form.password, form.confirmPassword);

  function updateField<K extends keyof FormState>(key: K) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setForm((prev) => ({ ...prev, [key]: next }));
    };
  }

  function toggleReveal(key: "password" | "confirmPassword") {
    setRevealed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");

    // Length and match, in that order — see validateRegisterFields for why the
    // order is load-bearing. The backend re-checks the length independently;
    // the match rule is client-only, since the second field never leaves here.
    const problem = validateRegisterFields(form.password, form.confirmPassword);
    if (problem) {
      setError(t[problem]);
      return;
    }

    setLoading(true);
    try {
      const result = await submitRegister(form.username, form.email, form.password);
      if (result.ok) {
        // Full navigation, not a soft router.replace — see redirectAfterAuth
        // (same reasoning as /login: the client-island Navbar updates only
        // racily on a soft nav). Lands the new account on `from`.
        redirectAfterAuth(from);
      } else {
        const translated = translateErrorMessage(result.message, dict);
        setError(translated || t.fail);
      }
    } finally {
      setLoading(false);
    }
  }

  // Both password rows are the same shape; the only differences are the id,
  // the autoComplete token and whether the row can show the mismatch state.
  function passwordRow(
    key: "password" | "confirmPassword",
    autoComplete: string,
    invalid: boolean,
  ) {
    const id = `register-${key}`;
    const shown = revealed[key];
    return (
      <div style={styles.passwordWrap}>
        <input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          value={form[key]}
          onChange={updateField(key)}
          onFocus={() => setFocused(key)}
          onBlur={() => setFocused(null)}
          required
          minLength={PASSWORD_MIN_LENGTH}
          disabled={busy}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "register-error" : undefined}
          style={styles.passwordInput(focused === key, invalid)}
        />
        <button
          type="button"
          onClick={() => toggleReveal(key)}
          // aria-pressed, not a label that flips between "show"/"hide": this
          // IS a toggle, and assistive tech announces the pressed state on top
          // of a stable name. The label still flips so the announcement names
          // the action a sighted user would expect from the icon.
          aria-pressed={shown}
          aria-label={shown ? t.hidePassword : t.showPassword}
          aria-controls={id}
          onMouseEnter={() => setHoveredReveal(key)}
          onMouseLeave={() => setHoveredReveal(null)}
          style={styles.reveal(shown, hoveredReveal === key)}
          // Deliberately focusable. The tempting `tabIndex={-1}` — used to keep
          // Tab walking straight from password to confirm to submit — makes the
          // reveal unreachable without a pointer, which fails WCAG 2.1.1 and
          // takes the feature away from exactly the users who benefit most from
          // it. One extra tab stop per password field is the correct trade.
        >
          {/* Crossed-out eye while revealed: the icon shows what the click
              does next, matching the aria-label, not the current state. */}
          <EyeIcon off={shown} />
        </button>
      </div>
    );
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
          {passwordRow("password", "new-password", false)}

          <label style={styles.label} htmlFor="register-confirmPassword">
            {t.confirmPassword}
          </label>
          {passwordRow("confirmPassword", "new-password", mismatchVisible)}

          {/* One error region for the whole form. The live mismatch is shown
              here too rather than under the field: a second, field-level
              message would put two contradicting-looking errors on screen the
              moment someone submits with a mismatch. */}
          <p id="register-error" role="alert" aria-live="polite" style={styles.error}>
            {error || (mismatchVisible ? t.pwdMismatch : "")}
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
