"use client";

import { useRef } from "react";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/home/time";
import DeviceTile from "./DeviceTile";
import SignOutOthers from "./SignOutOthers";
import { canEndOthers, otherSessions, type DeviceSession } from "./deviceSessions";
import { endOtherSessions, endSession } from "./settingsApi";
import "./settings-devices.css";

interface DevicesSectionProps {
  /** The sessions still standing, current first. */
  sessions: DeviceSession[];
  /** The request's clock, so "2 小时前" reads the same on the server and after hydration. */
  nowMs: number;
  onSignedOut: (ids: string[]) => void;
}

/**
 * 登录设备: every signed-in session of the account, as tiles. Any one but
 * this browser's can be signed out from here, or all of them at once.
 */
export default function DevicesSection({ sessions, nowMs, onSignedOut }: DevicesSectionProps) {
  const { lang, t } = useLang();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ending = useRef(false);
  const others = otherSessions(sessions);

  // The tile (or the button) that held focus is about to go; the heading
  // takes it, rather than the page's top.
  const settleFocus = () => headingRef.current?.focus({ preventScroll: true });

  const endOne = async (session: DeviceSession, name: string) => {
    if (ending.current) return;
    ending.current = true;
    const outcome = await endSession(session.id, lang);
    ending.current = false;
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    settleFocus();
    onSignedOut([session.id]);
    toast.success(fillTemplate(t("settings.signedOutDevice"), { name }));
  };

  const endOthers = async (): Promise<boolean> => {
    if (ending.current) return false;
    ending.current = true;
    const ids = others.map((s) => s.id);
    const outcome = await endOtherSessions(ids.length, lang);
    ending.current = false;
    if (!outcome.ok) {
      toast.error(outcome.error);
      return false;
    }
    settleFocus();
    onSignedOut(ids);
    toast.success(
      outcome.value === 1
        ? t("settings.signedOutOthersOne")
        : fillTemplate(t("settings.signedOutOthers"), { n: outcome.value }),
    );
    return true;
  };

  return (
    <section className="set-sec" id="devices" aria-labelledby="set-devices-h">
      <div className="set-sec-head">
        <h2 className="set-sec-title" id="set-devices-h" ref={headingRef} tabIndex={-1}>
          {t("settings.devicesTitle")}
        </h2>
        {canEndOthers(sessions) && <SignOutOthers count={others.length} onConfirm={endOthers} />}
      </div>
      {sessions.length > 0 && (
        // role="list" because Safari drops the list semantics of a <ul> whose
        // bullets are styled away, and VoiceOver then stops counting the tiles.
        <ul className="set-dv-grid" role="list">
          {sessions.map((session) => (
            <DeviceTile
              key={session.id}
              session={session}
              nowMs={nowMs}
              onEnd={(s, name) => void endOne(s, name)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
