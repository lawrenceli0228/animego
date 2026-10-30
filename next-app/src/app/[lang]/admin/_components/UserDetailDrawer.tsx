"use client";

// The user detail drawer: GET /api/admin/users/{id}, drawn by UserDetailPanel,
// and every change an admin can make to the account.
//
// A dialog in the full sense, the way FilterSheet and UnfollowDialog are:
// portalled to <body> (an ancestor's `isolation: isolate` would otherwise hold
// it under the page), the page scroll locked on <html> through
// lib/scrollLock.ts (a lock on <body> is a no-op on this site), focus moved in
// on open and kept in while open, Escape and a press on the backdrop close
// it, and focus handed back on close through onRestoreFocus — the list's,
// because only the list knows where it should go: the opener, or its heading
// after a delete, when the opener's row is about to disappear.
//
// Keeping focus in takes two things, because parts of the drawer disappear
// while they hold focus — a confirmation's 取消 closes the confirmation, a
// device's row goes after its sign-out, 重试 goes once the read restarts —
// and a browser then drops focus on <body>, outside the dialog:
//
//   - Escape and Tab are heard on the document, not on the dialog, so they
//     work wherever focus is. Tab from outside enters the dialog.
//   - Focus that has fallen out is put back inside after every change: on
//     the button that opened a closing panel (UserDetailActions), on the
//     next device (SessionList), or else on the dialog itself.
//
// After any change: a toast, the drawer reads the account again (or closes,
// after a delete), and the list refetches its current page (onChanged /
// onDeleted). A change that did not go through is reported in the drawer's
// own words (lib/adminUserErrors.ts), never in go-api's English or in what
// a thrown action carries — in production that is React's generic sentence —
// and as a toast when the drawer was closed before the answer came.
//
// Loaded by UsersSection through next/dynamic: this is the module that pulls
// react-hot-toast, which touches `document` on import, so nothing a bun test
// imports may reach it.

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-hot-toast";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import { focusIsLost } from "@/lib/lostFocus";
import { isImeKeystroke } from "@/lib/nav/navSearch";
import { useScrollLock } from "@/lib/scrollLock";
import {
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  passwordProblem,
  profilePatch,
  readUserDetail,
  type UserDrawerMode,
  type UserDrawerTarget,
} from "@/lib/adminUsers";
import { userActionErrorKey, type UserAction } from "@/lib/adminUserErrors";
import type { UserActionFailure } from "../_actions/_shared";
import {
  deleteAdminUser,
  revokeAdminUserSession,
  revokeAdminUserSessions,
  setAdminUserPassword,
  updateAdminUser,
} from "../_actions/users";
import type { AdminUserDetail, AdminUserSession } from "../_types/users";
import { UserDetailPanel, type DetailStatus } from "./UserDetailPanel";
import s from "./userDetail.module.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface UserDetailDrawerProps {
  target: UserDrawerTarget;
  /** Called once, as the drawer unmounts, to put focus back. Must be stable. */
  onRestoreFocus: () => void;
  onClose: () => void;
  /** The account changed: the list refetches its page. */
  onChanged: () => void;
  /**
   * The account `id` is gone: the list refetches, and closes the drawer if it
   * is still this account's. A delete can finish after its drawer was closed
   * and another account's opened, so the id is what says which.
   */
  onDeleted: (id: string) => void;
}

/** A thrown action — the network to Next, or Next itself — says only that it failed. */
const THROWN = { status: 0 };

/**
 * Tab inside the dialog, wrapping at either end. From outside it — focus
 * fell out, or never came in — Tab enters at the first control and
 * Shift+Tab at the last.
 */
function trapTab(dialog: HTMLElement, event: KeyboardEvent): void {
  const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  const at = document.activeElement;
  if (nodes.length === 0) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!at || !dialog.contains(at)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && (at === first || at === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && at === last) {
    event.preventDefault();
    first.focus();
  }
}

async function fetchDetail(
  userId: string,
  signal: AbortSignal,
): Promise<{ status: "ready"; detail: AdminUserDetail } | { status: "missing" | "error" }> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (res.status === 404) return { status: "missing" };
  if (!res.ok) return { status: "error" };
  const body = (await res.json()) as { data?: unknown };
  const detail = readUserDetail(body?.data);
  return detail ? { status: "ready", detail } : { status: "error" };
}

export default function UserDetailDrawer(props: UserDetailDrawerProps) {
  // Only ever mounted after a press, i.e. in the browser, so `document` exists.
  return createPortal(<Drawer {...props} />, document.body);
}

function Drawer({ target, onRestoreFocus, onClose, onChanged, onDeleted }: UserDetailDrawerProps) {
  const { t } = useLang();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [status, setStatus] = useState<DetailStatus>("loading");
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<UserDrawerMode>(target.mode);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [ending, setEnding] = useState<ReadonlySet<string>>(() => new Set());
  useScrollLock(true);
  // Whether the drawer is still on screen, for a change that finishes after
  // it closed (reportFailure).
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);

  // Focus in on open — unless an autofocused field already has it — and back
  // out on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    return () => onRestoreFocus();
  }, [onRestoreFocus]);

  // After every change: focus that fell out with whatever held it goes to the
  // dialog itself. The action row and the device list run their own effects
  // first (children before parents) and put it somewhere better when they can.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && focusIsLost()) dialog.focus({ preventScroll: true });
  });

  // Escape and Tab, wherever focus is, while the drawer is open. Captured on
  // the document because a handler on the dialog only heard keys while focus
  // was inside it, and stopped closing the drawer the moment it fell out.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        // An input method (pinyin) is using Escape to cancel what it is
        // composing; Safari says so only through the key code (isImeKeystroke).
        if (isImeKeystroke(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        trapTab(dialog, event);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Read the account; again after every change (`reload`).
  useEffect(() => {
    const ac = new AbortController();
    const run = async () => {
      setStatus((prev) => (prev === "ready" || prev === "refreshing" ? "refreshing" : "loading"));
      try {
        const result = await fetchDetail(target.id, ac.signal);
        if (ac.signal.aborted) return;
        if (result.status === "ready") setDetail(result.detail);
        setStatus(result.status);
      } catch {
        if (!ac.signal.aborted) setStatus("error");
      }
    };
    void run();
    return () => ac.abort();
  }, [target.id, reload]);

  const current = detail?.user ?? target;

  const changed = () => {
    setReload((n) => n + 1);
    onChanged();
  };

  /**
   * A failed change, in the drawer's words: under the control that asked for
   * it while the drawer is open, as a toast once it has closed. Escape and
   * the backdrop close it mid-request, and a failure that lands after that
   * would otherwise be written into a drawer nobody can see.
   */
  const reportFailure = (
    action: UserAction,
    failure: { status: number; message?: string },
    show: (text: string) => void,
  ) => {
    const text = t(userActionErrorKey(action, failure));
    if (openRef.current) show(text);
    else toast.error(text);
  };

  /**
   * One mutation at a time; its failure lands under the action row. `work`
   * answers with the action's failure, or null once it went through.
   */
  const perform = async (action: UserAction, work: () => Promise<UserActionFailure | null>) => {
    setBusy(true);
    setActionError(null);
    try {
      const failure = await work();
      if (failure) reportFailure(action, failure, setActionError);
    } catch {
      reportFailure(action, THROWN, setActionError);
    } finally {
      setBusy(false);
    }
  };

  const chooseMode = (next: UserDrawerMode) => {
    setActionError(null);
    setMode(next);
  };

  const saveProfile = (form: { username: string; email: string }) => {
    const result = profilePatch(form, current);
    if (result.kind === "invalid") {
      setActionError(
        result.reason === "usernameLength"
          ? fillTemplate(t("admin.usernameMinMax"), { min: USERNAME_MIN, max: USERNAME_MAX })
          : t("admin.invalidEmail"),
      );
      return;
    }
    if (result.kind === "unchanged") {
      chooseMode("view");
      return;
    }
    void perform("update", async () => {
      const outcome = await updateAdminUser(target.id, result.patch);
      // `=== false`: the repo compiles without strict null checks, and only
      // the literal comparison narrows this union.
      if (outcome.ok === false) return outcome;
      toast.success(fillTemplate(t("admin.userPanel.updated"), { username: outcome.data.username }));
      setMode("view");
      changed();
      return null;
    });
  };

  const savePassword = (password: string) => {
    if (passwordProblem(password)) {
      setActionError(fillTemplate(t("admin.passwordMinLen"), { min: PASSWORD_MIN }));
      return;
    }
    void perform("password", async () => {
      const outcome = await setAdminUserPassword(target.id, password);
      if (outcome.ok === false) return outcome;
      // A new password also ends every session (go-api migration 0052), so
      // the device list and the row's 最近设备 change too.
      toast.success(fillTemplate(t("admin.passwordResetSuccess"), { username: current.username }));
      setMode("view");
      changed();
      return null;
    });
  };

  const revokeAll = () => {
    void perform("revokeAll", async () => {
      const outcome = await revokeAdminUserSessions(target.id);
      if (outcome.ok === false) return outcome;
      const { revoked } = outcome.data;
      toast.success(
        revoked > 0
          ? fillTemplate(t("admin.userPanel.revokedAll"), { username: current.username, n: revoked })
          : fillTemplate(t("admin.userPanel.revokedNone"), { username: current.username }),
      );
      setMode("view");
      changed();
      return null;
    });
  };

  const revokeSession = async (session: AdminUserSession, deviceName: string) => {
    setEnding((prev) => new Set(prev).add(session.id));
    setDeviceError(null);
    try {
      const outcome = await revokeAdminUserSession(target.id, session.id);
      if (outcome.ok === false) {
        reportFailure("revokeOne", outcome, setDeviceError);
        return;
      }
      toast.success(fillTemplate(t("admin.userPanel.signedOutDevice"), { device: deviceName }));
      changed();
    } catch {
      reportFailure("revokeOne", THROWN, setDeviceError);
    } finally {
      setEnding((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        return next;
      });
    }
  };

  const remove = () => {
    void perform("delete", async () => {
      const outcome = await deleteAdminUser(target.id);
      if (outcome.ok === false) return outcome;
      toast.success(
        fillTemplate(t("admin.userPanel.deleted"), { username: outcome.data.username || current.username }),
      );
      onDeleted(target.id);
      return null;
    });
  };

  return (
    <div
      className={s.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={s.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-user-drawer={target.id}
      >
        <UserDetailPanel
          titleId={titleId}
          target={target}
          detail={detail}
          status={status}
          mode={mode}
          busy={busy}
          actionError={actionError}
          deviceError={deviceError}
          ending={ending}
          onClose={onClose}
          onRetry={() => setReload((n) => n + 1)}
          onMode={chooseMode}
          onSaveProfile={saveProfile}
          onSavePassword={savePassword}
          onRevokeAll={revokeAll}
          onRevokeSession={(session, name) => void revokeSession(session, name)}
          onDelete={remove}
        />
      </div>
    </div>
  );
}
