"use client";

// The blocks of the user detail drawer below the stat tiles: the 90-day visit
// calendar, the signed-in devices, the latest watches, the latest
// subscriptions and the community counts. Presentational: the drawer owns the
// fetch and the sign-out calls, and hands these the payload and callbacks.
//
// Every date is on the +08 clock and read against the payload's `today`.

import LocaleLink from "@/components/ui/LocaleLink";
import { pickTitle } from "@/lib/formatters";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { useLang } from "@/lib/lang-client";
import {
  countryCode,
  formatCount,
  monthDay,
  shanghaiDate,
  shortDate,
  shortDateTime,
  visitCalendar,
  type CalendarCell,
} from "@/lib/adminUsers";
import DeviceIcon from "../../settings/_components/DeviceIcon";
import { DEVICE_KINDS, type DeviceKind } from "../../settings/_components/deviceSessions";
import type { AdminAnimeTitles, AdminUserDetail, AdminUserSession, AdminUserSubscription } from "../_types/users";
import { useUserWords } from "./userWords";
import s from "./userDetail.module.css";

type T = (key: string) => string;

const kindOf = (kind: string): DeviceKind =>
  (DEVICE_KINDS as readonly string[]).includes(kind) ? (kind as DeviceKind) : "unknown";

/** A template's {{n}} in bold, the words around it as written. */
function BoldCount({ template, n }: { template: string; n: string }) {
  const [before, after = ""] = template.split("{{n}}");
  return (
    <span>
      {before}
      <b>{n}</b>
      {after}
    </span>
  );
}

function titleOf(item: AdminAnimeTitles, lang: Lang, t: T): string {
  return pickTitle(item, lang) || fillTemplate(t("admin.userPanel.untitled"), { id: item.anilistId });
}

// ─── 来访日历 ──────────────────────────────────────────────────────────────

export function VisitCalendar({ detail }: { detail: AdminUserDetail }) {
  const { t } = useLang();
  const model = visitCalendar(detail.activity.days90, detail.today);
  const weekdays = t("admin.userPanel.weekdays").split(",");
  const months = t("admin.userPanel.months").split(",");
  const since = detail.instrumentedSince ? monthDay(detail.instrumentedSince) : null;
  const label =
    model.reconstructed > 0
      ? fillTemplate(t("admin.userPanel.calendarLabelReconstructed"), { n: model.active, m: model.reconstructed })
      : fillTemplate(t("admin.userPanel.calendarLabel"), { n: model.active });

  const cellTitle = (cell: CalendarCell): string | undefined => {
    if (cell.state === "outside") return undefined;
    const month = Number(cell.date.slice(5, 7));
    const date = fillTemplate(t("admin.userPanel.calendarDate"), {
      m: month,
      d: Number(cell.date.slice(8, 10)),
      mon: months[month - 1] ?? String(month),
      wd: weekdays[cell.weekday - 1] ?? "",
    });
    const state =
      cell.state === "recorded"
        ? t("admin.userPanel.calendarRecorded")
        : cell.state === "reconstructed"
          ? since
            ? fillTemplate(t("admin.userPanel.calendarReconstructedSince"), { date: since })
            : t("admin.userPanel.calendarReconstructed")
          : t("admin.userPanel.calendarNone");
    return fillTemplate(t("admin.userPanel.calendarCell"), { date, state });
  };

  return (
    <section data-block="calendar">
      <h3 className={s.blockTitle}>
        {t("admin.userPanel.calendarTitle")} <small>{t("admin.userPanel.calendarSpan")}</small>
      </h3>
      <div className={s.cal} role="img" aria-label={label}>
        <div className={s.calRows} aria-hidden="true">
          {weekdays.map((day, i) => (
            <span key={`${day}-${i}`}>{i % 2 === 0 ? day : ""}</span>
          ))}
        </div>
        <div className={s.calWeeks}>
          {model.weeks.map((week) => (
            <div key={week.start} className={s.calWeek}>
              <div className={s.calMonth}>{week.month ? (months[week.month - 1] ?? "") : ""}</div>
              {week.cells.map((cell) => (
                <span
                  key={cell.date}
                  className={s.calCell}
                  data-state={cell.state}
                  data-today={cell.today || undefined}
                  title={cellTitle(cell)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={s.legend}>
        <span>
          <span className={`${s.swatch} ${s.swatchRecorded}`} aria-hidden="true" />
          {t("admin.userPanel.legendRecorded")}
        </span>
        {model.reconstructed > 0 ? (
          <span>
            <span className={`${s.swatch} ${s.swatchReconstructed}`} aria-hidden="true" />
            {since
              ? fillTemplate(t("admin.userPanel.legendReconstructedSince"), { date: since })
              : t("admin.userPanel.legendReconstructed")}
          </span>
        ) : null}
        <span>
          <span className={s.swatch} aria-hidden="true" />
          {t("admin.userPanel.legendNone")}
        </span>
      </div>
      <div className={s.calSum}>
        <BoldCount template={t("admin.userPanel.sumLast30")} n={formatCount(model.last30)} />
        {" · "}
        <BoldCount template={t("admin.userPanel.sum90")} n={formatCount(model.active)} />
        {" · "}
        <BoldCount template={t("admin.userPanel.sumAll")} n={formatCount(detail.activity.activeDays)} />
      </div>
    </section>
  );
}

// ─── 登录设备 ──────────────────────────────────────────────────────────────

export interface SessionListProps {
  detail: AdminUserDetail;
  /** Sessions with a sign-out in flight. */
  ending: ReadonlySet<string>;
  error: string | null;
  onRevoke: (session: AdminUserSession, deviceName: string) => void;
}

export function SessionList({ detail, ending, error, onRevoke }: SessionListProps) {
  const { t } = useLang();
  const words = useUserWords();
  const sessions = detail.sessions;
  return (
    <section data-block="sessions">
      <h3 className={s.blockTitle}>
        {t("admin.userPanel.devicesTitle")}{" "}
        <small>{fillTemplate(t("admin.userPanel.devicesCount"), { n: sessions.length })}</small>
      </h3>
      {sessions.length === 0 ? (
        <div className={s.list}>
          <p className={s.listEmpty}>{t("admin.userPanel.devicesNone")}</p>
        </div>
      ) : (
        // role="list": Safari drops the semantics of a <ul> styled without bullets.
        <ul className={s.devices} role="list">
          {sessions.map((session) => {
            const name = words.device(session.os, session.browser);
            const country = countryCode(session.country);
            const busy = ending.has(session.id);
            return (
              <li key={session.id} className={s.dev} data-session={session.id} aria-busy={busy || undefined}>
                <span className={s.devIcon} aria-hidden="true">
                  <DeviceIcon kind={kindOf(session.kind)} />
                </span>
                <div className={s.devText}>
                  <div className={s.devName}>
                    {name}
                    {country ? <span className={`${s.tag} ${s.tagInline}`}>{country}</span> : null}
                  </div>
                  <div className={s.devMeta}>
                    {fillTemplate(t("admin.userPanel.deviceMeta"), {
                      created: shortDateTime(session.createdAt, detail.today),
                      used: shortDateTime(session.lastUsedAt, detail.today),
                      expires: shortDate(shanghaiDate(session.expiresAt), detail.today),
                    })}
                  </div>
                </div>
                {/* aria-disabled, not disabled: a disabled button drops the focus that pressed it. */}
                <button
                  type="button"
                  className={s.btn}
                  aria-label={fillTemplate(t("admin.userPanel.signOutDeviceLabel"), { device: name })}
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) onRevoke(session, name);
                  }}
                >
                  {t("admin.userPanel.signOutDevice")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p role="alert" className={s.actionError}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ─── 最近观看 ──────────────────────────────────────────────────────────────

export function RecentWatches({ detail }: { detail: AdminUserDetail }) {
  const { t, lang } = useLang();
  return (
    <section data-block="watches">
      <h3 className={s.blockTitle}>
        {t("admin.userPanel.watchesTitle")}{" "}
        <small>{fillTemplate(t("admin.userPanel.watchesTotal"), { n: formatCount(detail.watches.total) })}</small>
      </h3>
      <div className={s.list}>
        {detail.recentWatches.length === 0 ? (
          <p className={s.listEmpty}>{t("admin.userPanel.watchesNone")}</p>
        ) : (
          detail.recentWatches.map((watch, i) => (
            <div key={`${watch.anilistId}:${watch.episode}:${i}`} className={`${s.li} ${s.liWatch}`}>
              <span className={s.liTime}>{shortDateTime(watch.watchedAt, detail.today)}</span>
              <span className={s.liTitle}>{titleOf(watch, lang, t)}</span>
              <span className={s.liEp}>
                {watch.episodes
                  ? fillTemplate(t("admin.userPanel.episodeOf"), { ep: watch.episode, total: watch.episodes })
                  : fillTemplate(t("admin.userPanel.episode"), { ep: watch.episode })}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ─── 追番 ──────────────────────────────────────────────────────────────────

function progressWords(item: AdminUserSubscription, t: T): string {
  if (item.status === "completed") {
    if (item.score === null) return t("admin.userPanel.unscored");
    const score = Number.isInteger(item.score) ? String(item.score) : item.score.toFixed(1);
    return fillTemplate(t("admin.userPanel.scored"), { score });
  }
  if (!item.currentEpisode) return t("admin.userPanel.notStarted");
  return item.episodes
    ? fillTemplate(t("admin.userPanel.progressOf"), { n: item.currentEpisode, total: item.episodes })
    : fillTemplate(t("admin.userPanel.progress"), { n: item.currentEpisode });
}

export function SubscriptionList({ detail }: { detail: AdminUserDetail }) {
  const { t, lang } = useLang();
  const words = useUserWords();
  const counts = detail.subscriptions;
  const part = (status: string, n: number) =>
    fillTemplate(t("admin.userPanel.subsPart"), { label: words.status(status), n: formatCount(n) });
  const summary = [
    part("watching", counts.watching),
    part("completed", counts.completed),
    part("plan_to_watch", counts.planToWatch),
    ...(counts.dropped > 0 ? [part("dropped", counts.dropped)] : []),
  ].join(" · ");

  return (
    <section data-block="subscriptions">
      <h3 className={s.blockTitle}>
        {t("admin.userPanel.subsTitle")} <small>{summary}</small>
      </h3>
      <div className={s.list}>
        {detail.recentSubscriptions.length === 0 ? (
          <p className={s.listEmpty}>{t("admin.userPanel.subsNone")}</p>
        ) : (
          detail.recentSubscriptions.map((item) => (
            <div key={item.anilistId} className={`${s.li} ${s.liSub}`}>
              <span className={s.liTitle}>{titleOf(item, lang, t)}</span>
              <span className={s.st} data-status={item.status}>
                {words.status(item.status)}
              </span>
              <span className={`${s.liEp} ${s.liProgress}`}>{progressWords(item, t)}</span>
            </div>
          ))
        )}
        {detail.user.isPublic ? (
          <LocaleLink
            className={s.listMore}
            href={`/u/${encodeURIComponent(detail.user.username)}`}
            prefetch={false}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("admin.userPanel.publicLink")}
          </LocaleLink>
        ) : null}
      </div>
    </section>
  );
}

// ─── 社区 ──────────────────────────────────────────────────────────────────

export function CommunityCounts({ detail }: { detail: AdminUserDetail }) {
  const { t } = useLang();
  const c = detail.community;
  const items: Array<[string, number]> = [
    [t("admin.userPanel.comments"), c.comments],
    [t("admin.userPanel.replies"), c.replies],
    [t("admin.userPanel.threads"), c.threads],
    [t("admin.userPanel.reviews"), c.reviews],
    [t("admin.userPanel.danmaku"), c.danmaku],
    [t("admin.userPanel.following"), c.following],
    [t("admin.userPanel.followers"), c.followers],
    [t("admin.userPanel.reportsFiled"), c.reportsFiled],
    [t("admin.userPanel.editSubmissions"), c.editSubmissions],
  ];
  return (
    <section data-block="community">
      <h3 className={s.blockTitle}>{t("admin.userPanel.communityTitle")}</h3>
      <div className={s.social}>
        {items.map(([label, n]) => (
          <span key={label}>
            {label}
            <b>{formatCount(n)}</b>
          </span>
        ))}
      </div>
    </section>
  );
}
