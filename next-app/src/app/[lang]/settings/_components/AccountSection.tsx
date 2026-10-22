"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/home/time";
import UsernameField from "./UsernameField";
import { sendPasswordLink } from "./settingsApi";
import { maskEmail, type UsernameEditor } from "./settingsState";

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
  const [link, setLink] = useState<LinkState>("idle");
  const masked = maskEmail(email);

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
        <UsernameField editor={editor} />

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

        <div className="set-row" aria-busy={link === "sending" || undefined}>
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
            {/* Disabled for good once sent; only held (aria-disabled, focus
                kept) while the request is out. */}
            <button
              type="button"
              className="set-btn ghost sm"
              disabled={link === "sent" || !email}
              aria-disabled={link === "sending" || undefined}
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
