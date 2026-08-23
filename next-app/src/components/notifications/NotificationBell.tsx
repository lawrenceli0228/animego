"use client";

import Link from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { pickRelatedTitle } from "@/lib/contentLabels";
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
  }
> = {
  zh: {
    unknownAnime: "番剧",
    followed: (actor) => `${actor} 关注了你`,
    liked: (actor, title) => `${actor} 赞了你在《${title}》的评论`,
    replied: (actor, title) => `${actor} 回复了你在《${title}》的评论`,
  },
  en: {
    unknownAnime: "an anime",
    followed: (actor) => `${actor} followed you`,
    // English drops the 《》 brackets, so the title is interpolated bare —
    // which is why these are functions of the title rather than a template
    // the caller fills in.
    liked: (actor, title) => `${actor} liked your comment on ${title}`,
    replied: (actor, title) => `${actor} replied to your comment on ${title}`,
  },
  "zh-Hant": {
    unknownAnime: "番劇",
    followed: (actor) => `${actor} 關注了你`,
    liked: (actor, title) => `${actor} 讚了你在《${title}》的評論`,
    replied: (actor, title) => `${actor} 回覆了你在《${title}》的評論`,
  },
};

function notificationCopy(
  item: CommunityNotification,
  lang: Lang,
): string {
  const copy = COPY[lang];
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
                      src={item.actor.avatarUrl ?? DEFAULT_AVATAR_IMAGE}
                      fallback={DEFAULT_AVATAR_IMAGE}
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
