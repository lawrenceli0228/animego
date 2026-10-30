"use client";

// What the user detail drawer shows, top to bottom: the header (who, role,
// public profile, registration time, short id), six stat tiles, the visit
// calendar, the signed-in devices, the latest watches, the latest
// subscriptions with the public-profile link, the community counts, and the
// action row.
//
// Presentational. UserDetailDrawer owns the portal, the focus trap, the
// fetch and the server actions; this renders whatever state it is handed,
// which is what lets the render tests draw every block and every inline
// confirmation without a browser.
//
// The header and the action row render from the row's summary as soon as
// the drawer opens: the account can still be edited or deleted when the
// detail endpoint is slow or failing.

import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import {
  avatarColor,
  avatarInitial,
  formatCount,
  formatScore,
  relativeDay,
  shanghaiDate,
  shanghaiDateTime,
  shortDate,
  shortDateTime,
  type UserDrawerMode,
  type UserDrawerTarget,
} from "@/lib/adminUsers";
import type { AdminUserDetail, AdminUserSession } from "../_types/users";
import { UserDetailActions } from "./UserDetailActions";
import { CommunityCounts, RecentWatches, SessionList, SubscriptionList, VisitCalendar } from "./UserDetailSections";
import { useUserWords } from "./userWords";
import s from "./userDetail.module.css";

/** loading: nothing yet; refreshing: re-reading after a change, the old payload still shown. */
export type DetailStatus = "loading" | "ready" | "refreshing" | "error" | "missing";

export interface UserDetailPanelProps {
  /** The id the dialog's aria-labelledby points at (the name heading). */
  titleId: string;
  target: UserDrawerTarget;
  detail: AdminUserDetail | null;
  status: DetailStatus;
  mode: UserDrawerMode;
  busy: boolean;
  actionError: string | null;
  deviceError: string | null;
  ending: ReadonlySet<string>;
  onClose: () => void;
  onRetry: () => void;
  onMode: (mode: UserDrawerMode) => void;
  onSaveProfile: (form: { username: string; email: string }) => void;
  onSavePassword: (password: string) => void;
  onRevokeAll: () => void;
  onRevokeSession: (session: AdminUserSession, deviceName: string) => void;
  onDelete: () => void;
}

function Identity({ titleId, target, detail }: Pick<UserDetailPanelProps, "titleId" | "target" | "detail">) {
  const { t } = useLang();
  const user = detail?.user;
  const username = user?.username ?? target.username;
  const email = user?.email ?? target.email;
  const role = user ? user.role : target.role;
  const createdAt = user?.createdAt ?? target.createdAt;
  const id = user?._id ?? target.id;
  const joined = shanghaiDateTime(createdAt);
  return (
    <div className={s.identity} data-block="identity">
      <div className={s.idRow}>
        <span className={s.bigAvatar} style={{ background: avatarColor(username) }} aria-hidden="true">
          {avatarInitial(username)}
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 id={titleId} className={s.name}>
            {username}
          </h2>
          <div className={s.email}>{email}</div>
          <div className={s.tags}>
            <span className={s.tag}>
              {role === "admin" ? t("admin.userPanel.roleAdmin") : t("admin.userPanel.roleUser")}
            </span>
            {user?.isPublic ? <span className={s.tag}>{t("admin.userPanel.publicProfile")}</span> : null}
          </div>
        </div>
      </div>
      <div className={s.meta}>
        {joined ? <span>{fillTemplate(t("admin.userPanel.joinedAt"), { time: joined })}</span> : null}
        <span title={id}>{fillTemplate(t("admin.userPanel.userId"), { id: id.slice(0, 8) })}</span>
        <span>{t("admin.userPanel.tzNote")}</span>
      </div>
    </div>
  );
}

function StatTiles({ detail }: { detail: AdminUserDetail }) {
  const { t } = useLang();
  const words = useUserWords();
  const { activity, subscriptions, watches, today } = detail;
  const seen = relativeDay(activity.lastSeenAt, today);
  const tiles = [
    {
      key: "activeDays",
      label: t("admin.userPanel.tileActiveDays"),
      value: formatCount(activity.activeDays),
      sub: fillTemplate(t("admin.userPanel.tileActiveDaysSub"), { n: formatCount(activity.recordedDays) }),
    },
    {
      key: "lastSeen",
      label: t("admin.userPanel.tileLastSeen"),
      value: !seen
        ? "—"
        : seen.kind === "later"
          ? shortDateTime(activity.lastSeenAt, today)
          : words.dayWord(seen.kind, seen.days),
      sub: seen ? shortDateTime(activity.lastSeenAt, today) : t("admin.userPanel.tileLastSeenNever"),
    },
    {
      key: "logins",
      label: t("admin.userPanel.tileLogins"),
      value: formatCount(activity.logins),
      sub: t("admin.userPanel.tileLoginsSub"),
    },
    {
      key: "subscriptions",
      label: t("admin.userPanel.tileSubs"),
      value: formatCount(subscriptions.total),
      sub: subscriptions.lastUpdatedAt
        ? fillTemplate(t("admin.userPanel.tileSubsSub"), {
            date: shortDate(shanghaiDate(subscriptions.lastUpdatedAt), today),
          })
        : "",
    },
    {
      key: "ratings",
      label: t("admin.userPanel.tileRatings"),
      value: formatCount(subscriptions.rated),
      sub:
        subscriptions.avgScore === null
          ? t("admin.userPanel.tileRatingsNone")
          : fillTemplate(t("admin.userPanel.tileRatingsSub"), { score: formatScore(subscriptions.avgScore) }),
    },
    {
      key: "watched",
      label: t("admin.userPanel.tileWatched"),
      value: fillTemplate(t("admin.userPanel.tileWatchedValue"), { n: formatCount(watches.total) }),
      sub: watches.lastWatchedAt
        ? fillTemplate(t("admin.userPanel.tileWatchedSub"), { time: shortDateTime(watches.lastWatchedAt, today) })
        : "",
    },
  ];
  return (
    <div className={s.tiles} data-block="tiles">
      {tiles.map((tile) => (
        <div key={tile.key} className={s.tile} data-tile={tile.key}>
          <div className={s.tileLabel}>{tile.label}</div>
          <div className={s.tileValue}>{tile.value}</div>
          {tile.sub ? <div className={s.tileSub}>{tile.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function UserDetailPanel(props: UserDetailPanelProps) {
  const { t } = useLang();
  const { titleId, target, detail, status, mode, busy, actionError, deviceError, ending } = props;
  const current = detail?.user ?? target;

  return (
    <>
      <div className={s.drawerTop}>
        <span className={s.drawerTopTitle}>{t("admin.userPanel.drawerTitle")}</span>
        <button type="button" className={s.close} aria-label={t("admin.userPanel.close")} onClick={props.onClose}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className={s.drawerBody} aria-busy={status === "loading" || status === "refreshing" || undefined}>
        <Identity titleId={titleId} target={target} detail={detail} />

        {status === "loading" ? (
          <p className={s.status} role="status">
            {t("admin.userPanel.loading")}
          </p>
        ) : null}
        {status === "missing" ? (
          <p className={s.status} role="alert">
            {t("admin.userPanel.detailMissing")}
          </p>
        ) : null}
        {status === "error" ? (
          <div role="alert" className={s.errorBox}>
            <span>{t("admin.userPanel.detailError")}</span>
            <button type="button" className={s.btn} onClick={props.onRetry}>
              {t("admin.userPanel.retry")}
            </button>
          </div>
        ) : null}

        {detail && status !== "missing" ? (
          <>
            <StatTiles detail={detail} />
            <VisitCalendar detail={detail} />
            <SessionList detail={detail} ending={ending} error={deviceError} onRevoke={props.onRevokeSession} />
            <RecentWatches detail={detail} />
            <SubscriptionList detail={detail} />
            <CommunityCounts detail={detail} />
          </>
        ) : null}

        {status !== "missing" ? (
          <UserDetailActions
            username={current.username}
            email={current.email}
            mode={mode}
            busy={busy}
            error={actionError}
            onMode={props.onMode}
            onSaveProfile={props.onSaveProfile}
            onSavePassword={props.onSavePassword}
            onRevokeAll={props.onRevokeAll}
            onDelete={props.onDelete}
          />
        ) : null}
      </div>
    </>
  );
}
