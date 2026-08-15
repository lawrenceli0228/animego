"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import FallbackImg from "@/components/ui/FallbackImg";
import { DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
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

function relativeTime(iso: string, lang: "zh" | "en"): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return lang === "zh" ? "刚刚" : "just now";
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return lang === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return lang === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  }
  const days = Math.floor(seconds / 86400);
  return lang === "zh" ? `${days} 天前` : `${days}d ago`;
}

function notificationCopy(
  item: CommunityNotification,
  lang: "zh" | "en",
): string {
  if (item.type === "follow") {
    return lang === "zh"
      ? `${item.actor.username} 关注了你`
      : `${item.actor.username} followed you`;
  }
  const title =
    lang === "zh"
      ? item.anime?.titleChinese || item.anime?.title
      : item.anime?.title || item.anime?.titleChinese;
  if (item.type === "comment_reaction") {
    return lang === "zh"
      ? `${item.actor.username} 赞了你在《${title ?? "番剧"}》的评论`
      : `${item.actor.username} liked your comment on ${title ?? "an anime"}`;
  }
  return lang === "zh"
    ? `${item.actor.username} 回复了你在《${title ?? "番剧"}》的评论`
    : `${item.actor.username} replied to your comment on ${title ?? "an anime"}`;
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
  return (
    <div className="agc-notification-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agc-notification-bell"
        aria-expanded={open}
        aria-controls={NOTIFICATION_PANEL_ID}
        aria-label={
          unreadCount > 0
            ? `${t("notification.title")} · ${unreadCount} ${t("notification.unread")}`
            : t("notification.title")
        }
        onClick={() => {
          if (!open) void loadPage();
          setOpen((value) => !value);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
        {badge && <span className="agc-notification-badge">{badge}</span>}
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
                    <FallbackImg
                      src={item.actor.avatarUrl ?? DEFAULT_CARD_IMAGE}
                      fallback={DEFAULT_CARD_IMAGE}
                      alt=""
                    />
                  </span>
                  <span className="agc-notification-copy">
                    <span>{notificationCopy(item, lang)}</span>
                    {item.isSpoiler ? (
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
