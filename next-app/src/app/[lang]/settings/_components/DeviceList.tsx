"use client";

import type { Ref } from "react";
import { useLang } from "@/lib/lang-client";
import DeviceTile from "./DeviceTile";
import type { DeviceSession } from "./deviceSessions";

interface DeviceListProps {
  sessions: DeviceSession[];
  /** The list could not be had (see readSessions): say so instead of showing nothing. */
  failed: boolean;
  nowMs: number;
  /** Sessions with a sign-out out. */
  busyIds: ReadonlySet<string>;
  onEnd: (session: DeviceSession, name: string, tile: HTMLElement | null) => void;
  ref?: Ref<HTMLUListElement>;
}

/** The 登录设备 tiles, or 加载失败 when there were none to be had. */
export default function DeviceList({ sessions, failed, nowMs, busyIds, onEnd, ref }: DeviceListProps) {
  const { t } = useLang();
  if (sessions.length === 0) {
    return failed ? (
      <div className="set-group">
        <p className="set-empty">{t("settings.loadFailed")}</p>
      </div>
    ) : null;
  }
  return (
    // role="list" because Safari drops the list semantics of a <ul> whose
    // bullets are styled away, and VoiceOver then stops counting the tiles.
    <ul className="set-dv-grid" role="list" ref={ref}>
      {sessions.map((session) => (
        <DeviceTile
          key={session.id}
          session={session}
          nowMs={nowMs}
          busy={busyIds.has(session.id)}
          onEnd={onEnd}
        />
      ))}
    </ul>
  );
}
