"use client";

// 谁在追: everyone with this anime on their list (public profiles), with
// their status and since when, under a one-line summary ("3 人 · 都已看完").
// The button puts the anime on the reader's own list.

import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import {
  ALL_KEY,
  SINCE_KEY,
  STATUS_LABEL_KEY,
  fillTemplate,
  formatCommunityDate,
  statusBreakdown,
} from "@/lib/community/format";
import type { CommunityWatchers } from "@/lib/community/types";
import Avatar from "./Avatar";
import s from "./community.module.css";

/** "3 人 · 都已看完" or "3 人 · 2 人看完 · 1 人在看". */
export function watchersSummary(watchers: CommunityWatchers, t: (key: string) => string): string {
  const people = fillTemplate(t("community.peopleCount"), { n: watchers.total });
  const rows = statusBreakdown(watchers.counts);
  if (rows.length === 0) return people;
  if (rows.length === 1) return `${people} · ${t(ALL_KEY[rows[0].status])}`;
  const parts = rows.map((row) =>
    fillTemplate(t("community.breakdownItem"), { n: row.count, status: t(STATUS_LABEL_KEY[row.status]) }),
  );
  return [people, ...parts].join(" · ");
}

interface WatchersCardProps {
  watchers: CommunityWatchers;
  lang: Lang;
  nowMs: number;
  /** Show 追番，出现在这里: the reader is signed out or does not follow it yet. */
  showFollow: boolean;
  canAct: boolean;
  loginHref: string;
  following: boolean;
  onFollow: () => void;
}

export default function WatchersCard({
  watchers,
  lang,
  nowMs,
  showFollow,
  canAct,
  loginHref,
  following,
  onFollow,
}: WatchersCardProps) {
  const { t } = useLang();
  return (
    <section className={s.card} aria-labelledby="community-watchers-heading">
      <h2 className={s.cardTitle} id="community-watchers-heading">
        {t("community.watchers")}
      </h2>
      {watchers.total > 0 ? (
        <>
          <div className={s.cardSub}>{watchersSummary(watchers, t)}</div>
          <ul className={s.whoList}>
            {watchers.items.map((w) => (
              <li key={w.username} className={s.who}>
                <Avatar name={w.username} avatarUrl={w.avatarUrl} backdropCoverUrl={w.backdropCoverUrl} />
                <div className={s.whoText}>
                  <Link href={`/u/${encodeURIComponent(w.username)}`} prefetch={false} className={`${s.name} ${s.whoName}`}>
                    {w.username}
                  </Link>
                  <div className={s.meta}>
                    {fillTemplate(t(SINCE_KEY[w.status]), { date: formatCommunityDate(w.since, lang, nowMs) })}
                  </div>
                </div>
                <span className={w.status === "dropped" ? s.chip : s.chipTone}>{t(STATUS_LABEL_KEY[w.status])}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className={s.cardSub}>{t("community.noWatchers")}</div>
      )}
      {showFollow ? (
        canAct ? (
          <button type="button" className={s.btnBlock} onClick={onFollow} disabled={following}>
            {t("community.followToJoin")}
          </button>
        ) : (
          <Link href={loginHref} prefetch={false} className={s.btnBlock}>
            {t("community.followToJoin")}
          </Link>
        )
      ) : null}
    </section>
  );
}
