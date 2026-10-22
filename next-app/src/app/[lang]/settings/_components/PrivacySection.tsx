"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import BlockedUsersList from "./BlockedUsersList";
import SettingSwitch from "./SettingSwitch";
import { patchMe } from "./settingsApi";

/**
 * 隐私与社区: the public-profile switch, which saves the moment it is flipped
 * (and flips back, with the reason, if the save fails), then the blocked list.
 */
export default function PrivacySection({ isPublic: initial }: { isPublic: boolean }) {
  const router = useRouter();
  const { lang, t } = useLang();
  const [isPublic, setIsPublic] = useState(initial);
  // One save at a time: a flip that lands while one is out is ignored, so a
  // failure can only ever revert to a value the server really had.
  const saving = useRef(false);

  const toggle = async (next: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setIsPublic(next);
    const outcome = await patchMe({ isPublic: next }, lang);
    saving.current = false;
    if (!outcome.ok) {
      setIsPublic(!next);
      toast.error(outcome.error);
      return;
    }
    toast.success(t("settings.saved"));
    // Keeps the router's copy of this page current for back/forward.
    router.refresh();
  };

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
          onChange={(next) => void toggle(next)}
        />
      </div>
      <BlockedUsersList />
    </section>
  );
}
