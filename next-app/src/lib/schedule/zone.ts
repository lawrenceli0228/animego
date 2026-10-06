// Which clock the schedule's times are on, as a few words for its subtitle.
//
// The page renders in Shanghai time on the server and switches every time to
// the browser's own zone after hydration (useHomeClock). The note follows the
// same switch: "北京时间（UTC+8）" until then, and afterwards either the same
// words (a browser on UTC+8 sees the same times) or the reader's own offset.
//
// Pure: no React, no DOM.

import { SITE_TZ } from "@/lib/home/time";

/** Asia/Shanghai, in minutes east of UTC. China keeps no daylight saving. */
export const SITE_UTC_OFFSET_MIN = 480;

/** "UTC+8", "UTC−3:30", "UTC" — minutes east of UTC, with a real minus sign. */
export function utcOffsetLabel(minutesEast: number): string {
  if (minutesEast === 0) return "UTC";
  const sign = minutesEast > 0 ? "+" : "−";
  const abs = Math.abs(minutesEast);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

export type ZoneNote = { kind: "site" } | { kind: "local"; offset: string };

/**
 * @param timeZone what useHomeClock reports: SITE_TZ before hydration,
 *   undefined (the runtime's own zone) after.
 * @param runtimeOffsetMin the runtime zone's offset now, minutes east of UTC
 *   (`-new Date(nowMs).getTimezoneOffset()`); ignored before hydration.
 */
export function zoneNote(timeZone: string | undefined, runtimeOffsetMin: number): ZoneNote {
  if (timeZone === SITE_TZ || runtimeOffsetMin === SITE_UTC_OFFSET_MIN) return { kind: "site" };
  return { kind: "local", offset: utcOffsetLabel(runtimeOffsetMin) };
}
