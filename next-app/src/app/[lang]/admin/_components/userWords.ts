// The labels the user list and the detail drawer share, in the reader's
// language.
//
// Every t() key here is written out as a literal, never assembled: the
// spaDictCoverage gate finds keys by scanning for t("…") in files that call
// useLang(, and a key built from a variable ships unguarded. That is why the
// switch statements below spell out each case instead of indexing a table.
//
// The numbers and dates come from @/lib/adminUsers, which reads the payload's
// `today` and the fixed +08 clock — nothing here touches Date.now() or the
// browser's zone, so the server pass and hydration print the same words.

import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { useLang } from "@/lib/lang-client";
import {
  deviceLabel,
  relativeDay,
  returnNote,
  shanghaiDateTime,
  shortDateTime,
  type ReturnNote,
} from "@/lib/adminUsers";
import { browserLabel } from "../../settings/_components/deviceLabels";
import type { AdminUserRow, AdminUserSegment, AdminUserSort } from "../_types/users";

type T = (key: string) => string;

export interface LastSeenWords {
  /** "今天 10:19", "昨天 23:05", "3 天前". */
  main: string;
  /** The line under it: 注册当天 / 注册后第 N 天回来, or the exact time for "N 天前". */
  sub: string;
  /** The full +08 time, for the title attribute. */
  title: string;
}

function noteWords(note: ReturnNote, t: T): string {
  if (!note) return "";
  return note.kind === "signupDay"
    ? t("admin.userPanel.signupDay")
    : fillTemplate(t("admin.userPanel.firstReturn"), { n: note.days });
}

/** The day word alone — what the drawer's 最近活跃 tile shows large. */
function dayWord(kind: "today" | "yesterday" | "daysAgo", days: number, t: T): string {
  switch (kind) {
    case "today":
      return t("admin.userPanel.todayWord");
    case "yesterday":
      return t("admin.userPanel.yesterdayWord");
    case "daysAgo":
      return fillTemplate(t("admin.userPanel.daysAgo"), { n: days });
  }
}

function lastSeen(
  row: Pick<AdminUserRow, "createdAt" | "lastSeenAt" | "recentActiveDates">,
  today: string,
  t: T,
): LastSeenWords | null {
  const rel = relativeDay(row.lastSeenAt, today);
  if (!rel) return null;
  const title = fillTemplate(t("admin.userPanel.beijingTime"), { time: shanghaiDateTime(row.lastSeenAt) });
  switch (rel.kind) {
    case "today":
      return {
        main: fillTemplate(t("admin.userPanel.today"), { time: rel.time }),
        sub: noteWords(returnNote(row, today), t),
        title,
      };
    case "yesterday":
      return {
        main: fillTemplate(t("admin.userPanel.yesterday"), { time: rel.time }),
        sub: noteWords(returnNote(row, today), t),
        title,
      };
    case "daysAgo":
      return {
        main: dayWord("daysAgo", rel.days, t),
        sub: shortDateTime(row.lastSeenAt, today),
        title,
      };
    case "later":
      return { main: shortDateTime(row.lastSeenAt, today), sub: "", title };
  }
}

function segment(seg: AdminUserSegment, t: T): string {
  switch (seg) {
    case "all":
      return t("admin.userPanel.segAll");
    case "active7":
      return t("admin.userPanel.segActive7");
    case "returned":
      return t("admin.userPanel.segReturned");
    case "neverReturned":
      return t("admin.userPanel.segNeverReturned");
    case "subscribed":
      return t("admin.userPanel.segSubscribed");
    case "admin":
      return t("admin.userPanel.segAdmin");
  }
}

function sort(key: AdminUserSort, t: T): string {
  switch (key) {
    case "lastSeen":
      return t("admin.userPanel.sortLastSeen");
    case "joined":
      return t("admin.userPanel.sortJoined");
    case "activeDays":
      return t("admin.userPanel.sortActiveDays");
    case "subscriptions":
      return t("admin.userPanel.sortSubscriptions");
    case "watched":
      return t("admin.userPanel.sortWatched");
  }
}

/** 在看 / 看过 / 想看 / 弃番; an unknown status is shown as sent. */
function status(value: string, t: T): string {
  switch (value) {
    case "watching":
      return t("admin.userPanel.statusWatching");
    case "completed":
      return t("admin.userPanel.statusCompleted");
    case "plan_to_watch":
      return t("admin.userPanel.statusPlan");
    case "dropped":
      return t("admin.userPanel.statusDropped");
    default:
      return value;
  }
}

function device(os: string, browser: string, t: T, lang: Lang): string {
  return deviceLabel(os, browser ? browserLabel(browser, lang) : "", {
    unknownOs: t("admin.userPanel.unknownOs"),
    unknownBrowser: t("admin.userPanel.unknownBrowser"),
    unknownDevice: t("admin.userPanel.unknownDevice"),
  });
}

export interface UserWords {
  lastSeen: (row: Pick<AdminUserRow, "createdAt" | "lastSeenAt" | "recentActiveDates">, today: string) => LastSeenWords | null;
  dayWord: (kind: "today" | "yesterday" | "daysAgo", days: number) => string;
  segment: (seg: AdminUserSegment) => string;
  sort: (key: AdminUserSort) => string;
  status: (value: string) => string;
  device: (os: string, browser: string) => string;
}

export function useUserWords(): UserWords {
  const { t, lang } = useLang();
  return {
    lastSeen: (row, today) => lastSeen(row, today, t),
    dayWord: (kind, days) => dayWord(kind, days, t),
    segment: (seg) => segment(seg, t),
    sort: (key) => sort(key, t),
    status: (value) => status(value, t),
    device: (os, browser) => device(os, browser, t, lang),
  };
}
