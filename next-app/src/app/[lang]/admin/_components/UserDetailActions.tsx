"use client";

// The drawer's action row — 编辑资料 / 重置密码 / 退出全部设备 / 删除用户… — and
// what each one opens in place: the profile form, the password form, or an
// inline confirmation. Nothing destructive happens on the first press.
//
// Presentational: the drawer runs the server actions and passes back `busy`
// and `error`. While busy, buttons are aria-disabled rather than disabled
// and inputs read-only, so the control that was just pressed keeps focus.
//
// When a panel closes — 取消, a save or confirmation that went through — the
// control that had focus goes with it, and focus would fall to <body>,
// outside the drawer. It goes back to the button that opened the panel.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import { PASSWORD_MIN, type UserDrawerMode } from "@/lib/adminUsers";
import { focusIsLost } from "@/lib/lostFocus";
import s from "./userDetail.module.css";

export interface UserDetailActionsProps {
  /** The account as it stands — the edit form starts from these. */
  username: string;
  email: string;
  mode: UserDrawerMode;
  busy: boolean;
  error: string | null;
  onMode: (mode: UserDrawerMode) => void;
  onSaveProfile: (form: { username: string; email: string }) => void;
  onSavePassword: (password: string) => void;
  onRevokeAll: () => void;
  onDelete: () => void;
}

export function UserDetailActions({
  username,
  email,
  mode,
  busy,
  error,
  onMode,
  onSaveProfile,
  onSavePassword,
  onRevokeAll,
  onDelete,
}: UserDetailActionsProps) {
  const { t } = useLang();
  const panelId = useId();
  const blockRef = useRef<HTMLDivElement | null>(null);
  // The panel open at the last commit, to know which one just closed.
  const shownRef = useRef(mode);

  useEffect(() => {
    const closed = shownRef.current;
    shownRef.current = mode;
    if (closed === mode || closed === "view" || !focusIsLost()) return;
    blockRef.current?.querySelector<HTMLElement>(`[data-opens="${closed}"]`)?.focus();
  }, [mode]);

  const toggle = (next: UserDrawerMode) => {
    if (!busy) onMode(mode === next ? "view" : next);
  };
  const opens = (next: UserDrawerMode) => ({
    "aria-expanded": mode === next,
    "aria-controls": mode === next ? panelId : undefined,
    "data-opens": next,
  });
  const cancel = () => {
    if (!busy) onMode("view");
  };

  return (
    <div data-block="actions" ref={blockRef}>
      <div className={s.actions}>
        <button type="button" className={s.btn} {...opens("edit")} onClick={() => toggle("edit")}>
          {t("admin.userPanel.edit")}
        </button>
        <button type="button" className={s.btn} {...opens("password")} onClick={() => toggle("password")}>
          {t("admin.userPanel.password")}
        </button>
        <button type="button" className={s.btn} {...opens("revokeAll")} onClick={() => toggle("revokeAll")}>
          {t("admin.userPanel.revokeAll")}
        </button>
        <span className={s.spacer} />
        <button
          type="button"
          className={`${s.btn} ${s.btnDanger}`}
          {...opens("delete")}
          onClick={() => toggle("delete")}
        >
          {t("admin.userPanel.remove")}
        </button>
      </div>

      {mode === "edit" ? (
        <ProfileForm
          id={panelId}
          username={username}
          email={email}
          busy={busy}
          onSave={onSaveProfile}
          onCancel={cancel}
        />
      ) : null}
      {mode === "password" ? (
        <PasswordForm id={panelId} username={username} busy={busy} onSave={onSavePassword} onCancel={cancel} />
      ) : null}
      {mode === "revokeAll" ? (
        <Confirm
          id={panelId}
          kind="revokeAll"
          label={t("admin.userPanel.revokeAllConfirmLabel")}
          text={fillTemplate(t("admin.userPanel.revokeAllConfirm"), { username })}
          confirmLabel={t("admin.userPanel.revokeAllConfirmButton")}
          busy={busy}
          onConfirm={onRevokeAll}
          onCancel={cancel}
        />
      ) : null}
      {mode === "delete" ? (
        <Confirm
          id={panelId}
          kind="delete"
          label={t("admin.userPanel.deleteConfirmLabel")}
          text={fillTemplate(t("admin.userPanel.deleteConfirm"), { username })}
          confirmLabel={t("admin.userPanel.deleteConfirmButton")}
          solid
          busy={busy}
          onConfirm={onDelete}
          onCancel={cancel}
        />
      ) : null}

      {error ? (
        <p role="alert" className={s.actionError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface FormButtonsProps {
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
}

function FormButtons({ busy, submitLabel, onCancel }: FormButtonsProps) {
  const { t } = useLang();
  return (
    <div className={s.inlineButtons}>
      <button type="submit" className={`${s.btn} ${s.btnSave}`} aria-disabled={busy || undefined}>
        {submitLabel}
      </button>
      <button type="button" className={s.btn} aria-disabled={busy || undefined} onClick={onCancel}>
        {t("admin.cancel")}
      </button>
    </div>
  );
}

interface ProfileFormProps {
  id: string;
  username: string;
  email: string;
  busy: boolean;
  onSave: (form: { username: string; email: string }) => void;
  onCancel: () => void;
}

function ProfileForm({ id, username, email, busy, onSave, onCancel }: ProfileFormProps) {
  const { t } = useLang();
  const nameId = useId();
  const mailId = useId();
  const [form, setForm] = useState({ username, email });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) onSave(form);
  };
  return (
    <form id={id} className={s.inlineForm} onSubmit={submit} data-form="edit">
      <label className={s.srOnly} htmlFor={nameId}>
        {t("admin.usernameLabel")}
      </label>
      <input
        id={nameId}
        className={s.input}
        value={form.username}
        onChange={(event) => setForm({ ...form, username: event.target.value })}
        placeholder={t("admin.usernameLabel")}
        autoComplete="off"
        readOnly={busy}
        autoFocus
      />
      <label className={s.srOnly} htmlFor={mailId}>
        {t("admin.emailLabel")}
      </label>
      <input
        id={mailId}
        type="email"
        className={s.input}
        value={form.email}
        onChange={(event) => setForm({ ...form, email: event.target.value })}
        placeholder={t("admin.emailLabel")}
        autoComplete="off"
        readOnly={busy}
      />
      <FormButtons busy={busy} submitLabel={t("admin.save")} onCancel={onCancel} />
    </form>
  );
}

interface PasswordFormProps {
  id: string;
  username: string;
  busy: boolean;
  onSave: (password: string) => void;
  onCancel: () => void;
}

function PasswordForm({ id, username, busy, onSave, onCancel }: PasswordFormProps) {
  const { t } = useLang();
  const inputId = useId();
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) onSave(password);
  };
  return (
    <form id={id} className={s.inlineForm} onSubmit={submit} data-form="password">
      <label className={s.srOnly} htmlFor={inputId}>
        {fillTemplate(t("admin.newPasswordLabel"), { username })}
      </label>
      <input
        id={inputId}
        type="password"
        className={s.input}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={fillTemplate(t("admin.newPasswordPlaceholder"), { username, min: PASSWORD_MIN })}
        autoComplete="new-password"
        readOnly={busy}
        autoFocus
      />
      <FormButtons busy={busy} submitLabel={t("admin.savePassword")} onCancel={onCancel} />
    </form>
  );
}

interface ConfirmProps {
  id: string;
  kind: "revokeAll" | "delete";
  label: string;
  text: string;
  confirmLabel: string;
  /** The filled red button: for the one step that cannot be undone. */
  solid?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Inline, in the drawer; focus lands on 取消, the safe answer. */
function Confirm({ id, kind, label, text, confirmLabel, solid = false, busy, onConfirm, onCancel }: ConfirmProps) {
  const { t } = useLang();
  const textId = useId();
  return (
    <div id={id} className={s.confirm} role="alertdialog" aria-label={label} aria-describedby={textId} data-confirm={kind}>
      <div id={textId}>{text}</div>
      <div className={s.confirmButtons}>
        <button type="button" className={s.btn} aria-disabled={busy || undefined} onClick={onCancel} autoFocus>
          {t("admin.cancel")}
        </button>
        <button
          type="button"
          className={`${s.btn} ${solid ? s.btnDangerSolid : s.btnDanger}`}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
