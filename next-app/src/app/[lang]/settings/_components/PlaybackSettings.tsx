"use client";

import { useState, useSyncExternalStore } from "react";
import { useLang } from "@/lib/lang-client";
import {
  AUTO_MARK_DONE_DEFAULT,
  readAutoMarkDone,
  subscribeAutoMarkDone,
  writeAutoMarkDone,
} from "@/lib/playerSettings";
import SettingSwitch from "./SettingSwitch";

// localStorage is a browser-only mutable store, which is exactly what
// useSyncExternalStore is for: the server snapshot renders the default so
// hydration matches, then React swaps in the real value. Same shape the
// /library hooks use. Module scope keeps the identities stable across renders.
const getSnapshot = (): boolean => readAutoMarkDone();
const getServerSnapshot = (): boolean => AUTO_MARK_DONE_DEFAULT;

/**
 * 播放.
 *
 * Unlike every other section on this page, nothing here goes to the server —
 * the switch lives in this device's localStorage, so it applies the moment it
 * is flipped and there is no Save button to press and no dirty state to track.
 */
export default function PlaybackSettings() {
  const { t } = useLang();
  const autoMarkDone = useSyncExternalStore(
    subscribeAutoMarkDone,
    getSnapshot,
    getServerSnapshot,
  );
  const [saveFailed, setSaveFailed] = useState(false);

  // A store that refuses the write leaves the player reading the old value, so
  // the switch stays where it was — the snapshot never moved. Showing the
  // requested state would be a lie, and saying nothing is the §9 CG1 habit.
  const toggle = (next: boolean) => setSaveFailed(!writeAutoMarkDone(next));

  return (
    <section className="set-sec" id="playback" aria-labelledby="set-playback-h">
      <div className="set-sec-head">
        <div>
          <h2 className="set-sec-title" id="set-playback-h">
            {t("settings.playbackTitle")}
          </h2>
          <p className="set-sec-sub">{t("settings.playbackSubtitle")}</p>
        </div>
      </div>
      <div className="set-group">
        <SettingSwitch
          id="set-auto-mark"
          title={t("settings.autoMarkDone")}
          description={autoMarkDone ? t("settings.autoMarkDoneOn") : t("settings.autoMarkDoneOff")}
          checked={autoMarkDone}
          onChange={toggle}
        />
        {saveFailed && (
          <p className="set-tg-err" role="alert">
            {t("settings.autoMarkDoneSaveFailed")}
          </p>
        )}
      </div>
    </section>
  );
}
