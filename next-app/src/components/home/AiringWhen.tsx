"use client";

// " · 周日 19:00 更新第 14 集" inside a server-rendered popover.
//
// A leaf, so the grid around it stays a server component. Rendered in the
// site's zone on the server and during hydration, the browser's zone after
// (useHomeClock), and dropped once the episode has gone out.

import { fillTemplate, weekdayTime } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import { useHomeClock } from "./useHomeClock";

export default function AiringWhen({ at, ep }: { at: number; ep: number }) {
  const { lang, t } = useLang();
  // 0: the server already chose an upcoming airing; only the client re-checks.
  const { nowMs, timeZone } = useHomeClock(0);
  if (nowMs !== 0 && at <= nowMs) return null;
  return (
    <>
      {" · "}
      {weekdayTime(at, timeZone, lang)} {fillTemplate(t("home.heroEpUpdate"), { ep })}
    </>
  );
}
