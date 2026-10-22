"use client";

import { useRef, type FormEvent } from "react";
import { useLang } from "@/lib/lang-client";
import type { UsernameEditor } from "./settingsState";

/** The server's limit (go-api/internal/auth/account.go, maxUsernameLen). */
const USERNAME_MAX = 50;

const HIDDEN_ID = "set-username-hidden";
const HINT_ID = "set-username-hint";

/**
 * The 用户名 row: the field, its 保存 (only while there is a name worth
 * saving), why there is none for one or two characters, and the notice when
 * the server is masking the registered name.
 */
export default function UsernameField({ editor }: { editor: UsernameEditor }) {
  const { t } = useLang();
  const inputRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 保存 goes away with a successful save; if it held focus, the field gets it.
    const fromButton = document.activeElement === saveRef.current;
    if ((await editor.save()) && fromButton) inputRef.current?.focus();
  };

  const describedBy = [editor.hidden ? HIDDEN_ID : null, editor.tooShort ? HINT_ID : null]
    .filter(Boolean)
    .join(" ");

  return (
    // Top-aligned while something sits under the field, so the label stays
    // level with the field rather than with the middle of the row.
    <div className={editor.hidden || editor.tooShort ? "set-row set-row-top" : "set-row"}>
      <label className="set-row-label" htmlFor="set-username">
        {t("settings.usernameLabel")}
      </label>
      <div className="set-row-main">
        <form className="set-name" onSubmit={(event) => void submit(event)} aria-busy={editor.saving || undefined}>
          <input
            ref={inputRef}
            id="set-username"
            className="set-input"
            value={editor.draft}
            maxLength={USERNAME_MAX}
            // "nickname", not "username": sign-in is by email here, so a
            // password manager's "username" for this site is the address.
            autoComplete="nickname"
            spellCheck={false}
            onChange={(event) => editor.setDraft(event.target.value)}
            aria-describedby={describedBy || undefined}
          />
          {editor.canSave && (
            // aria-disabled rather than disabled while the save is out: a
            // disabled button drops keyboard focus, and save() ignores a
            // second press anyway.
            <button
              ref={saveRef}
              type="submit"
              className="set-btn sm"
              aria-disabled={editor.saving || undefined}
            >
              {editor.saving ? t("settings.saving") : t("settings.save")}
            </button>
          )}
        </form>
        {/* Always in the page, so the hint is announced when it appears. */}
        <div aria-live="polite">
          {editor.tooShort && (
            <p id={HINT_ID} className="set-field-hint">
              {t("settings.usernameTooShort")}
            </p>
          )}
        </div>
        {editor.hidden && (
          // Each run of copy is a single string expression rather than JSX
          // text. JSX turns a newline + indent into a space, which is correct
          // for English and wrong for Chinese.
          <div id={HIDDEN_ID} className="set-warn">
            <p className="set-warn-title">{t("settings.usernameHiddenTitle")}</p>
            <p className="set-warn-body">{t("settings.usernameHiddenBody")}</p>
            <code className="set-warn-code">{editor.saved}</code>
          </div>
        )}
      </div>
    </div>
  );
}
