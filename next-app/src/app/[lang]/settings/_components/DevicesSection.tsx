"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/home/time";
import DeviceList from "./DeviceList";
import SignOutOthers from "./SignOutOthers";
import { canEndOthers, otherSessions, type DeviceSession } from "./deviceSessions";
import { shouldMoveFocus, type FocusContainer } from "./focusRule";
import { endOtherSessions, endSession } from "./settingsApi";
import "./settings-devices.css";

interface DevicesSectionProps {
  /** The sessions still standing, current first. */
  sessions: DeviceSession[];
  /** The list could not be loaded (see readSessions). */
  failed: boolean;
  /** The request's clock, so "2 小时前" reads the same on the server and after hydration. */
  nowMs: number;
  onSignedOut: (ids: string[]) => void;
}

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set([...ids, id]);
}

function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set([...ids].filter((x) => x !== id));
}

/**
 * 登录设备: every signed-in session of the account, as tiles. Any one but
 * this browser's can be signed out from here, or all of them at once.
 *
 * Several tiles can be signing out at once; each holds its own 退出 until its
 * request answers. While 全部退出 is out, every other tile holds too.
 */
export default function DevicesSection({ sessions, failed, nowMs, onSignedOut }: DevicesSectionProps) {
  const { lang, t } = useLang();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [ending, setEnding] = useState<ReadonlySet<string>>(() => new Set());
  const [endingOthers, setEndingOthers] = useState(false);
  const others = otherSessions(sessions);
  const busyIds = endingOthers ? new Set([...ending, ...others.map((s) => s.id)]) : ending;

  // What held focus is about to go. If focus is still in it (or already lost
  // to the body) the heading takes it; if the reader has moved on — typing a
  // new username while the request was out, say — it stays where it is.
  const settleFocus = (leaving: ReadonlyArray<FocusContainer | null>) => {
    if (shouldMoveFocus(document.activeElement, document.body, leaving)) {
      headingRef.current?.focus({ preventScroll: true });
    }
  };

  const endOne = async (session: DeviceSession, name: string, tile: HTMLElement | null) => {
    setEnding((ids) => withId(ids, session.id));
    const outcome = await endSession(session.id, lang);
    setEnding((ids) => withoutId(ids, session.id));
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    settleFocus([tile]);
    onSignedOut([session.id]);
    toast.success(fillTemplate(t("settings.signedOutDevice"), { name }));
  };

  const endOthers = async (): Promise<boolean> => {
    if (endingOthers) return false;
    setEndingOthers(true);
    const ids = others.map((s) => s.id);
    const outcome = await endOtherSessions(ids.length, lang);
    setEndingOthers(false);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return false;
    }
    // The confirm and its button go, and every tile but this device's.
    settleFocus([actionsRef.current, listRef.current]);
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
        {canEndOthers(sessions) && (
          <div ref={actionsRef}>
            <SignOutOthers count={others.length} busy={endingOthers} onConfirm={endOthers} />
          </div>
        )}
      </div>
      <DeviceList
        ref={listRef}
        sessions={sessions}
        failed={failed}
        nowMs={nowMs}
        busyIds={busyIds}
        onEnd={(session, name, tile) => void endOne(session, name, tile)}
      />
    </section>
  );
}
