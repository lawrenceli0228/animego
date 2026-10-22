"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import BlockedUsersList from "./BlockedUsersList";
import SettingSwitch from "./SettingSwitch";
import { latestWins } from "./latestWins";
import { patchMe } from "./settingsApi";

/**
 * 隐私与社区: the public-profile switch, which saves the moment it is flipped,
 * then the blocked list.
 *
 * The switch never waits and never drops a flip: a flip made while a save is
 * out is sent once that save answers (latestWins), and 已保存 is said once,
 * about the value the switch shows. A failure puts the switch back to what
 * the server holds, with the reason.
 */
export default function PrivacySection({ isPublic: initial }: { isPublic: boolean }) {
  const router = useRouter();
  const { lang, t } = useLang();
  const [isPublic, setIsPublic] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Made once. lang, t and router do not change while this page is mounted:
  // another language is another URL, and so another page.
  const [sync] = useState(() =>
    latestWins<boolean>({
      saved: initial,
      send: (value) => patchMe({ isPublic: value }, lang),
      onBusy: setBusy,
      onSaved: () => {
        toast.success(t("settings.saved"));
        // Keeps the router's copy of this page current for back/forward.
        router.refresh();
      },
      onFailed: (held, error) => {
        setIsPublic(held);
        toast.error(error);
      },
    }),
  );

  return (
    <section className="set-sec" id="privacy" aria-labelledby="set-privacy-h">
      <div className="set-sec-head">
        <h2 className="set-sec-title" id="set-privacy-h">
          {t("settings.privacyTitle")}
        </h2>
      </div>
      <div className="set-group">
        <SettingSwitch
          id="set-public"
          title={t("settings.publicProfile")}
          description={isPublic ? t("settings.publicProfileOn") : t("settings.publicProfileOff")}
          checked={isPublic}
          busy={busy}
          onChange={(next) => {
            setIsPublic(next);
            sync.want(next);
          }}
        />
      </div>
      <BlockedUsersList />
    </section>
  );
}
