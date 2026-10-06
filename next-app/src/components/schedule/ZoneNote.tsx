"use client";

// "时间为北京时间（UTC+8）" — the clock the schedule's times are on.
//
// A leaf, so the header around it stays a server component. It follows the
// same switch as every time on the page (useHomeClock): the site's zone during
// SSR and hydration, the browser's zone afterwards, at which point a reader
// outside UTC+8 is told their own offset instead.

import { fillTemplate } from "@/lib/home/time";
import { runtimeOffsetMinutes, SITE_UTC_OFFSET_MIN, zoneNote } from "@/lib/schedule/zone";
import { useLang } from "@/lib/lang-client";
import { useHomeClock } from "@/components/home/useHomeClock";

export default function ZoneNote() {
  const { t } = useLang();
  // 0: before hydration the note does not need a time, only the zone.
  const { nowMs, timeZone } = useHomeClock(0);
  const note = zoneNote(timeZone, timeZone === undefined ? runtimeOffsetMinutes(nowMs) : SITE_UTC_OFFSET_MIN);
  return <>{note.kind === "site" ? t("schedule.zoneSite") : fillTemplate(t("schedule.zoneLocal"), { offset: note.offset })}</>;
}
