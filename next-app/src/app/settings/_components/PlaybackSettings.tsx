"use client";

import { useState, useSyncExternalStore } from "react";
import { useLang } from "@/lib/lang-client";
import {
  AUTO_MARK_DONE_DEFAULT,
  readAutoMarkDone,
  subscribeAutoMarkDone,
  writeAutoMarkDone,
} from "@/lib/playerSettings";

// localStorage is a browser-only mutable store, which is exactly what
// useSyncExternalStore is for: the server snapshot renders the default so
// hydration matches, then React swaps in the real value. Same shape the
// /library hooks use. Module scope keeps the identities stable across renders.
const getSnapshot = (): boolean => readAutoMarkDone();
const getServerSnapshot = (): boolean => AUTO_MARK_DONE_DEFAULT;

/**
 * Playback preferences card.
 *
 * Unlike every other card on this page, nothing here goes to the server — the
 * switch lives in this device's localStorage, so it applies the moment it is
 * flipped and there is no Save button to press and no dirty state to track.
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
  // the checkbox stays where it was — the snapshot never moved. Showing the
  // requested state would be a lie, and saying nothing is the §9 CG1 habit.
  const toggle = (next: boolean) => setSaveFailed(!writeAutoMarkDone(next));

  return (
    <section className="set-card">
      <h2>{t("settings.playbackTitle")}</h2>
      <p className="sub">{t("settings.playbackSubtitle")}</p>

      <label className="set-toggle" htmlFor="set-auto-mark-done">
        <input
          id="set-auto-mark-done"
          type="checkbox"
          checked={autoMarkDone}
          onChange={(event) => toggle(event.target.checked)}
        />
        <span>
          <b>{t("settings.autoMarkDone")}</b>
          <span className="set-toggle-desc">
            {autoMarkDone
              ? t("settings.autoMarkDoneOn")
              : t("settings.autoMarkDoneOff")}
          </span>
        </span>
      </label>

      {saveFailed && (
        <p className="set-msg err" style={{ margin: "14px 0 0" }} role="alert">
          {t("settings.autoMarkDoneSaveFailed")}
        </p>
      )}
    </section>
  );
}
