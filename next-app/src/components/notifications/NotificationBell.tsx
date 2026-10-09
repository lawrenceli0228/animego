"use client";

import Link from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { pickRelatedTitle } from "@/lib/contentLabels";
import { characterDisplayName, personDisplayName } from "@/lib/people/names";
import { formatRelativeTime } from "@/lib/formatters";
import FallbackImg from "@/components/ui/FallbackImg";
import { DEFAULT_AVATAR_IMAGE } from "@/lib/cardDefaults";
import { dispatchDiscussionNavigation } from "@/components/anime/episodeDiscussionState";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationBadge,
  notificationTarget,
  parseNotificationPage,
  parseUnreadCount,
  type CommunityNotification,
  type NotificationPage,
} from "./notificationState";
import "./notification-bell.css";

const EMPTY_PAGE: NotificationPage = { items: [], unreadCount: 0 };
const NOTIFICATION_PANEL_ID = "notification-panel";

/**
 * The panel's clock, read at render time.
 *
 * A thin wrapper rather than `formatRelativeTime(…, Date.now())` written into
 * the JSX: react-hooks/purity rejects an impure call in a component body, and
 * this panel genuinely wants "now" at paint (it is a dropdown that opens on
 * demand, not a server-rendered list, so there is no hydration mismatch to
 * avoid). formatRelativeTime takes the clock as a parameter because its other
 * caller — the SSR'd activity feed — has to pin one; this one does not.
 */
function relativeTime(iso: string, lang: Lang): string {
  return formatRelativeTime(iso, lang, Date.now());
}

// The three sentences this panel can render, per language.
//
// They used to be three `lang === "zh" ? … : …` ternaries fed by a fourth one
// that picked the anime title. All four kept compiling once a third language
// existed and all four resolved to English for it — so the panel would have
// rendered an English sentence under a Traditional heading, in a dropdown
// nobody re-reads once it works.
const COPY: Record<
  Lang,
  {
    unknownAnime: string;
    followed: (actor: string) => string;
    liked: (actor: string, title: string) => string;
    replied: (actor: string, title: string) => string;
    /** The outcome of a reviewed edit to a person or character page. */
    edited: (name: string, accepted: number, rejected: number) => string;
    noteSeparator: string;
  }
> = {
  zh: {
    unknownAnime: "番剧",
    followed: (actor) => `${actor} 关注了你`,
    liked: (actor, title) => `${actor} 赞了你在《${title}》的评论`,
    replied: (actor, title) => `${actor} 回复了你在《${title}》的评论`,
    edited: (name, accepted, rejected) =>
      rejected === 0
        ? `你对「${name}」的修改已采纳`
        : accepted === 0
          ? `你对「${name}」的修改未被采纳`
          : `你对「${name}」的修改：采纳 ${accepted} 处，未采纳 ${rejected} 处`,
    noteSeparator: "；",
  },
  en: {
    unknownAnime: "an anime",
    followed: (actor) => `${actor} followed you`,
    // English drops the 《》 brackets, so the title is interpolated bare —
    // which is why these are functions of the title rather than a template
    // the caller fills in.
    liked: (actor, title) => `${actor} liked your comment on ${title}`,
    replied: (actor, title) => `${actor} replied to your comment on ${title}`,
    edited: (name, accepted, rejected) =>
      rejected === 0
        ? `Your edit to ${name} was accepted`
        : accepted === 0
          ? `Your edit to ${name} was not accepted`
          : `Your edit to ${name}: ${accepted} accepted, ${rejected} not accepted`,
    noteSeparator: "; ",
  },
  "zh-Hant": {
    unknownAnime: "番劇",
    followed: (actor) => `${actor} 關注了你`,
    liked: (actor, title) => `${actor} 讚了你在《${title}》的評論`,
    replied: (actor, title) => `${actor} 回覆了你在《${title}》的評論`,
    edited: (name, accepted, rejected) =>
      rejected === 0
        ? `你對「${name}」的修改已採納`
        : accepted === 0
          ? `你對「${name}」的修改未被採納`
          : `你對「${name}」的修改：採納 ${accepted} 處，未採納 ${rejected} 處`,
    noteSeparator: "；",
  },
};

function notificationCopy(
  item: CommunityNotification,
  lang: Lang,
): string {
  const copy = COPY[lang];
  if (item.type === "edit_review" && item.edit) {
    const name =
      (item.edit.kind === "person"
        ? personDisplayName(item.edit.name, lang)
        : characterDisplayName(item.edit.name, lang)) || `#${item.edit.entityId}`;
    return copy.edited(name, item.edit.accepted, item.edit.rejected);
  }
  if (item.type === "follow") return copy.followed(item.actor.username);
  // pickRelatedTitle rather than a local ladder: same helper the relation
  // rows and the activity feed use, so all three agree on which title a
  // language prefers. Resolves identically to the old chain for zh and en.
  const title =
    (item.anime ? pickRelatedTitle(item.anime, lang) : "") || copy.unknownAnime;
  return item.type === "comment_reaction"
    ? copy.liked(item.actor.username, title)
    : copy.replied(item.actor.username, title);
}

/**
 * The bell's footprint with nothing in it, for the header's probing state —
 * so the controls to its right do not jump when the session probe resolves
 * and the real bell takes the slot. Same class as the bell, so same box.
 */
export function NotificationBellSkeleton() {
  return <span className="agc-notification-bell agc-notification-bell--skeleton" aria-hidden="true" />;
}

export default function NotificationBell() {
  const pathname = usePathname();
  const { lang, t } = useLang();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<NotificationPage>(EMPTY_PAGE);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const loadUnread = useCallback(async () => {
    try {
      const response = await authFetch("/api/notifications/unread-count", {
        skipRedirectOnFailure: true,
      });
      if (!response.ok) return;
      setUnreadCount(parseUnreadCount(await response.json()));
    } catch {
      // The bell is secondary chrome. A transient count failure should not
      // turn every page navigation into an account error banner.
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUnread(), 0);
    return () => window.clearTimeout(timer);
  }, [loadUnread, pathname]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await authFetch("/api/notifications?limit=20", {
        skipRedirectOnFailure: true,
      });
      if (!response.ok) throw new Error("notifications failed");
      const next = parseNotificationPage(await response.json());
      setPage(next);
      setUnreadCount(next.unreadCount);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [loadPage, open]);

  const readOne = async (item: CommunityNotification) => {
    if (item.readAt) return;
    const before = page;
    const beforeCount = unreadCount;
    const now = new Date().toISOString();
    setPage((before) => markNotificationRead(before, item.id, now));
    setUnreadCount((before) => Math.max(0, before - 1));
    try {
      const response = await authFetch(`/api/notifications/${item.id}/read`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        skipRedirectOnFailure: true,
      });
      if (!response.ok) throw new Error("mark read failed");
    } catch {
      // A discussion notification can navigate only within the current anime
      // pathname. In that case the pathname effect does not re-fetch the
      // badge, so restore the exact pre-click state on a failed mutation.
      setPage(before);
      setUnreadCount(beforeCount);
    }
  };

  const readAll = async () => {
    const before = page;
    const beforeCount = unreadCount;
    const now = new Date().toISOString();
    setPage((current) => markAllNotificationsRead(current, now));
    setUnreadCount(0);
    try {
      const response = await authFetch("/api/notifications/read-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        skipRedirectOnFailure: true,
      });
      if (!response.ok) throw new Error("read all failed");
    } catch {
      setPage(before);
      setUnreadCount(beforeCount);
    }
  };

  const badge = notificationBadge(unreadCount);
  const label =
    unreadCount > 0
      ? `${t("notification.title")} · ${unreadCount} ${t("notification.unread")}`
      : t("notification.title");
  return (
    <div className="agc-notification-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agc-notification-bell"
        aria-expanded={open}
        aria-controls={NOTIFICATION_PANEL_ID}
        aria-label={label}
        // The bar shows a dot, not a number; the count is in the accessible
        // name and, for a pointer, in the tooltip.
        title={badge ? `${t("notification.title")} · ${badge}` : undefined}
        onClick={() => {
          if (!open) void loadPage();
          setOpen((value) => !value);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" />
          <path d="M10 20.5h4" />
        </svg>
        {badge && <span className="agc-notification-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div
          id={NOTIFICATION_PANEL_ID}
          className="agc-notification-popover"
          role="region"
          aria-label={t("notification.title")}
        >
          <div className="agc-notification-head">
            <strong>{t("notification.title")}</strong>
            {unreadCount > 0 && (
              <button type="button" onClick={() => void readAll()}>
                {t("notification.readAll")}
              </button>
            )}
          </div>
          <div className="agc-notification-list" aria-live="polite">
            {loading ? (
              <div className="agc-notification-state">{t("common.loading")}</div>
            ) : loadError ? (
              <div className="agc-notification-state">
                <span>{t("notification.loadError")}</span>
                <button type="button" onClick={() => void loadPage()}>{t("notification.retry")}</button>
              </div>
            ) : page.items.length === 0 ? (
              <div className="agc-notification-state">{t("notification.empty")}</div>
            ) : (
              page.items.map((item) => (
                <Link
                  key={item.id}
                  href={notificationTarget(item)}
                  prefetch={false}
                  className={`agc-notification-item${item.readAt ? "" : " unread"}`}
                  onNavigate={() => {
                    dispatchDiscussionNavigation(notificationTarget(item));
                  }}
                  onClick={() => {
                    void readOne(item);
                    setOpen(false);
                  }}
                >
                  <span className="agc-notification-avatar">
                    {/* A reviewed edit shows the page it was on, not who reviewed it. */}
                    <FallbackImg
                      src={(item.edit ? item.edit.image : item.actor.avatarUrl) ?? DEFAULT_AVATAR_IMAGE}
                      fallback={DEFAULT_AVATAR_IMAGE}
                      alt=""
                    />
                  </span>
                  <span className="agc-notification-copy">
                    <span>{notificationCopy(item, lang)}</span>
                    {item.edit && item.edit.rejectNotes.length > 0 ? (
                      <small>{item.edit.rejectNotes.join(COPY[lang].noteSeparator)}</small>
                    ) : item.isSpoiler ? (
                      <small>{t("comment.spoilerPreview")}</small>
                    ) : item.excerpt ? (
                      <small>“{item.excerpt}”</small>
                    ) : null}
                    <time dateTime={item.createdAt}>{relativeTime(item.createdAt, lang)}</time>
                  </span>
                  {!item.readAt && <i aria-label={t("notification.unread")} />}
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
