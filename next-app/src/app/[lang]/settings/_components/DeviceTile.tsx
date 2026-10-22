"use client";

import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/home/time";
import DeviceIcon from "./DeviceIcon";
import { deviceName, lastActiveLabel, metaPrefix, signedInLabel } from "./deviceLabels";
import type { DeviceSession } from "./deviceSessions";

interface DeviceTileProps {
  session: DeviceSession;
  /** The request's clock, so "2 小时前" reads the same on the server and after hydration. */
  nowMs: number;
  /** Called with the tile's own device name, for the toast. */
  onEnd: (session: DeviceSession, name: string) => void;
}

/**
 * One signed-in session: what it is, where and when it was last used, and
 * when it signed in. This browser's own is marked 本机 and cannot be ended
 * from here; every other one has a 退出.
 */
export default function DeviceTile({ session, nowMs, onEnd }: DeviceTileProps) {
  const { lang, t } = useLang();
  const name = deviceName(session.os, session.browser, lang);
  const when = lastActiveLabel(session.lastUsedAt, session.current, lang, nowMs);
  const since = signedInLabel(session.createdAt, lang);
  return (
    <li className={session.current ? "set-dv set-dv-cur" : "set-dv"}>
      <div className="set-dv-top">
        <span className="set-dv-ico" aria-hidden="true">
          <DeviceIcon kind={session.kind} />
        </span>
        {session.current ? (
          <span className="set-dv-tag">{t("settings.thisDevice")}</span>
        ) : (
          <button
            type="button"
            className="set-btn ghost sm"
            aria-label={fillTemplate(t("settings.signOutDevice"), { name })}
            onClick={() => onEnd(session, name)}
          >
            {t("settings.signOut")}
          </button>
        )}
      </div>
      <div>
        <p className="set-dv-name">
          <span>{name}</span>
        </p>
        <p className="set-dv-meta">
          {metaPrefix(session.place, when)}
          {when && <span className={session.current ? "set-dv-live" : undefined}>{when}</span>}
        </p>
        {since && <p className="set-dv-since">{since}</p>}
      </div>
    </li>
  );
}
