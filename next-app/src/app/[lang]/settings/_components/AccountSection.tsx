"use client";

import { useRef, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/home/time";
import { sendPasswordLink } from "./settingsApi";
import { maskEmail } from "./settingsState";
import type { UsernameEditor } from "./useUsernameEditor";

/** The server's limit (go-api/internal/auth/account.go, maxUsernameLen). */
const USERNAME_MAX = 50;

interface AccountSectionProps {
  editor: UsernameEditor;
  /** "AGC-123456". */
  memberNo: string;
  /** The account's address, from /api/auth/me; shown masked. */
  email: string;
}

type LinkState = "idle" | "sending" | "sent";

export default function AccountSection({ editor, memberNo, email }: AccountSectionProps) {
  const { lang, t } = useLang();
  const inputRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [link, setLink] = useState<LinkState>("idle");
  const masked = maskEmail(email);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 保存 goes away with a successful save; if it held focus, the field gets it.
    const fromButton = document.activeElement === saveRef.current;
    if ((await editor.save()) && fromButton) inputRef.current?.focus();
  };

  // The same email link the login page's 忘记密码 sends: a password change
  // has to prove the inbox, so a hijacked session cannot do it on its own.
  const sendLink = async () => {
    if (link !== "idle" || !email) return;
    setLink("sending");
    const outcome = await sendPasswordLink(email, lang);
    if (!outcome.ok) {
      setLink("idle");
      toast.error(outcome.error);
      return;
    }
    setLink("sent");
    toast.success(t("settings.passwordLinkSent"));
  };

  return (
    <section className="set-sec" id="account" aria-labelledby="set-account-h">
      <div className="set-sec-head">
        <h2 className="set-sec-title" id="set-account-h">
          {t("settings.accountTitle")}
        </h2>
      </div>
      <div className="set-group">
        <div className={editor.hidden ? "set-row set-row-top" : "set-row"}>
          <label className="set-row-label" htmlFor="set-username">
            {t("settings.usernameLabel")}
          </label>
          <div className="set-row-main">
            <form className="set-name" onSubmit={(event) => void submit(event)}>
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
                aria-describedby={editor.hidden ? "set-username-hidden" : undefined}
              />
              {editor.canSave && (
                <button ref={saveRef} type="submit" className="set-btn sm">
                  {t("settings.save")}
                </button>
              )}
            </form>
            {editor.hidden && (
              // Each run of copy is a single string expression rather than JSX
              // text. JSX turns a newline + indent into a space, which is
              // correct for English and wrong for Chinese.
              <div id="set-username-hidden" className="set-warn">
                <p className="set-warn-title">{t("settings.usernameHiddenTitle")}</p>
                <p className="set-warn-body">{t("settings.usernameHiddenBody")}</p>
                <code className="set-warn-code">{editor.saved}</code>
              </div>
            )}
          </div>
        </div>

        <div className="set-row">
          <span className="set-row-label">{t("settings.memberNoLabel")}</span>
          <div className="set-row-main">
            <span className="set-row-val set-mono">{`#${memberNo}`}</span>
          </div>
        </div>

        <div className="set-row">
          <span className="set-row-label">{t("settings.emailLabel")}</span>
          <div className="set-row-main">
            <span className="set-row-val">{masked}</span>
          </div>
        </div>

        <div className="set-row">
          <span className="set-row-label">{t("settings.passwordLabel")}</span>
          <div className="set-row-main">
            {link === "sent" ? (
              <span className="set-row-ok">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
                {fillTemplate(t("settings.passwordLinkSentTo"), { email: masked })}
              </span>
            ) : (
              <span className="set-row-val" aria-hidden="true">
                ••••••••
              </span>
            )}
          </div>
          <div className="set-row-end">
            <button
              type="button"
              className="set-btn ghost sm"
              disabled={link === "sent" || !email}
              onClick={() => void sendLink()}
            >
              {t("settings.sendPasswordLink")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
