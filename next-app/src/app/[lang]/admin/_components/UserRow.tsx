"use client";

// One account in the admin user list.
//
// Columns: who (initial, name, email, ADMIN), when they registered, when they
// were last seen, the 30-day strip, three counts, the newest live device, and
// a ⋯ menu. Every date is on the +08 reporting clock and every relative label
// is measured against the payload's `today` — the old row printed UTC dates,
// so an account registered at 07:30 in Shanghai showed the previous day.
//
// The row changes nothing itself. 查看详情 and the username open the detail
// drawer; the other menu items open it with that action already in front —
// the edit form, the password form, or an inline confirmation — so a
// destructive step always happens with the account's whole picture in view.
//
// The menu is portalled to <body> with fixed coordinates: inside the table's
// horizontal scroller it would be clipped on a short result list.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import {
  activityStrip,
  avatarColor,
  avatarInitial,
  countryCode,
  formatCount,
  menuPlacement,
  shanghaiDate,
  shortDateTime,
  type MenuPlacement,
  type UserDrawerMode,
} from "@/lib/adminUsers";
import type { AdminUserRow } from "../_types/users";
import { useUserWords } from "./userWords";
import s from "./users.module.css";

/** Five items and a separator at 13px, padding included; used only to decide up or down. */
const MENU_HEIGHT_ESTIMATE = 214;

export interface UserRowProps {
  user: AdminUserRow;
  /** The payload's reporting day: the strip's last cell and every relative label. */
  today: string;
  menuOpen: boolean;
  /** Open this row's menu (its id) or close whichever is open (null). */
  onMenu: (userId: string | null) => void;
  /** Open the drawer; `opener` gets focus back when it closes. */
  onOpen: (user: AdminUserRow, mode: UserDrawerMode, opener: HTMLElement | null) => void;
}

function Count({ n }: { n: number }) {
  const zero = !n;
  return (
    <span className={zero ? s.zero : undefined} data-zero={zero || undefined}>
      {formatCount(n)}
    </span>
  );
}

export function UserRow({ user, today, menuOpen, onMenu, onOpen }: UserRowProps) {
  const { t } = useLang();
  const words = useUserWords();
  const dotsRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  const cells = activityStrip(user.recentActiveDates, today);
  const recent = cells.filter((c) => c.active).length;
  const seen = words.lastSeen(user, today);
  const device = user.lastDevice;
  const country = countryCode(device?.country);

  // Outside press, scroll or resize closes the menu: its coordinates were
  // taken when it opened and would no longer sit under the button.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || dotsRef.current?.contains(target))) return;
      onMenu(null);
    };
    const onMove = () => onMenu(null);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [menuOpen, onMenu]);

  const toggleMenu = (button: HTMLButtonElement) => {
    if (menuOpen) {
      onMenu(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setPlacement(
      menuPlacement(rect, { width: window.innerWidth, height: window.innerHeight }, MENU_HEIGHT_ESTIMATE),
    );
    onMenu(user._id);
  };

  const closeMenu = (refocus: boolean) => {
    onMenu(null);
    if (refocus) dotsRef.current?.focus({ preventScroll: true });
  };

  const choose = (mode: UserDrawerMode) => {
    onMenu(null);
    onOpen(user, mode, dotsRef.current);
  };

  return (
    <tr className={s.tr} data-user-row={user._id}>
      <td className={s.td}>
        <div className={s.who}>
          <span className={s.avatar} style={{ background: avatarColor(user.username) }} aria-hidden="true">
            {avatarInitial(user.username)}
          </span>
          <div style={{ minWidth: 0 }}>
            <button type="button" className={s.uname} onClick={(event) => onOpen(user, "view", event.currentTarget)}>
              {user.username}
            </button>
            {user.role === "admin" ? <span className={s.badge}>{t("admin.userPanel.adminBadge")}</span> : null}
            <span className={s.mail}>{user.email}</span>
          </div>
        </div>
      </td>
      <td className={`${s.td} ${s.time}`}>{shanghaiDate(user.createdAt)}</td>
      <td className={s.td} title={seen ? seen.title : t("admin.lastSeenNever")}>
        {seen ? (
          <>
            <span className={`${s.time} ${s.timeMain}`}>{seen.main}</span>
            {seen.sub ? <span className={s.subLine}>{seen.sub}</span> : null}
          </>
        ) : (
          // An em dash, never a date: nothing was ever recorded for this
          // account, which for one older than the instrumentation is a
          // statement about our records, not about the person.
          <span className={s.dim}>—</span>
        )}
      </td>
      <td className={s.td}>
        <span
          className={s.strip}
          role="img"
          aria-label={fillTemplate(t("admin.userPanel.stripLabel"), { n: recent })}
          data-strip
        >
          {cells.map((cell) => (
            <span key={cell.date} className={s.cell} data-active={cell.active} data-today={cell.today || undefined} />
          ))}
        </span>
        <span className={s.days}>
          {fillTemplate(t("admin.userPanel.stripDays"), { n: recent, total: formatCount(user.activeDays) })}
        </span>
      </td>
      <td className={`${s.td} ${s.num}`}>
        <Count n={user.subscriptions} />
      </td>
      <td className={`${s.td} ${s.num}`}>
        <Count n={user.ratings} />
      </td>
      <td className={`${s.td} ${s.num}`}>
        <Count n={user.watchedEpisodes} />
      </td>
      <td
        className={`${s.td} ${s.device}`}
        title={
          device ? fillTemplate(t("admin.userPanel.deviceUsed"), { time: shortDateTime(device.lastUsedAt, today) }) : undefined
        }
      >
        {device ? (
          <>
            {words.device(device.os, device.browser)}
            {country ? <span className={s.cc}>{country}</span> : null}
          </>
        ) : (
          <span className={s.dim}>—</span>
        )}
      </td>
      <td className={`${s.td} ${s.moreCell}`}>
        <button
          ref={dotsRef}
          type="button"
          className={s.dots}
          aria-label={fillTemplate(t("admin.userPanel.more"), { username: user.username })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => toggleMenu(event.currentTarget)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
        {menuOpen && placement
          ? createPortal(
              <UserRowMenu
                username={user.username}
                menuRef={menuRef}
                style={{
                  top: placement.top ?? undefined,
                  bottom: placement.bottom ?? undefined,
                  right: placement.right,
                }}
                onChoose={choose}
                onClose={closeMenu}
              />,
              document.body,
            )
          : null}
      </td>
    </tr>
  );
}

export interface UserRowMenuProps {
  username: string;
  menuRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  onChoose: (mode: UserDrawerMode) => void;
  /** Escape or Tab: close, and put focus back on the ⋯ button. */
  onClose: (refocus: boolean) => void;
}

/**
 * The ⋯ menu's items. Focus lands on the first one; ↑/↓, Home and End move
 * between them; Escape and Tab close it and return focus to the button.
 */
export function UserRowMenu({ username, menuRef, style, onChoose, onClose }: UserRowMenuProps) {
  const { t } = useLang();
  const ownRef = useRef<HTMLDivElement | null>(null);
  const ref = menuRef ?? ownRef;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [ref]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length].focus();
    };
    switch (event.key) {
      case "Escape":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        return;
      case "ArrowDown":
        move(at + 1);
        return;
      case "ArrowUp":
        move(at < 0 ? items.length - 1 : at - 1);
        return;
      case "Home":
        move(0);
        return;
      case "End":
        move(items.length - 1);
        return;
    }
  };

  const item = (mode: UserDrawerMode, label: string, danger = false) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={danger ? `${s.menuItem} ${s.menuDanger}` : s.menuItem}
      data-menu-item={mode}
      onClick={() => onChoose(mode)}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={fillTemplate(t("admin.userPanel.more"), { username })}
      className={s.menu}
      style={style}
      onKeyDown={onKeyDown}
      data-user-menu
    >
      {item("view", t("admin.userPanel.view"))}
      {item("edit", t("admin.userPanel.edit"))}
      {item("password", t("admin.userPanel.password"))}
      {item("revokeAll", t("admin.userPanel.revokeAll"))}
      <div className={s.menuSep} role="separator" />
      {item("delete", t("admin.userPanel.remove"), true)}
    </div>
  );
}
