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
// After any change: a toast, the drawer reads the account again (or closes,
// after a delete), and the list refetches its current page (onChanged /
// onDeleted).
//
// Loaded by UsersSection through next/dynamic: this is the module that pulls
// react-hot-toast, which touches `document` on import, so nothing a bun test
// imports may reach it.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-hot-toast";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
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
  /** The account is gone: the list closes the drawer and refetches. */
  onDeleted: () => void;
}

/** A thrown action's message when it carries one, else the action's own words. */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
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

  // Focus in on open — unless an autofocused field already has it — and back
  // out on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    return () => onRestoreFocus();
  }, [onRestoreFocus]);

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

  /** One mutation at a time; its failure lands under the action row. */
  const perform = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch (err) {
      setActionError(messageOf(err, fallback));
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
    void perform(async () => {
      const updated = await updateAdminUser(target.id, result.patch);
      toast.success(fillTemplate(t("admin.userPanel.updated"), { username: updated.username }));
      setMode("view");
      changed();
    }, t("admin.updateFailed"));
  };

  const savePassword = (password: string) => {
    if (passwordProblem(password)) {
      setActionError(fillTemplate(t("admin.passwordMinLen"), { min: PASSWORD_MIN }));
      return;
    }
    void perform(async () => {
      await setAdminUserPassword(target.id, password);
      // A new password also ends every session (go-api migration 0052), so
      // the device list and the row's 最近设备 change too.
      toast.success(fillTemplate(t("admin.passwordResetSuccess"), { username: current.username }));
      setMode("view");
      changed();
    }, t("admin.passwordChangeFailed"));
  };

  const revokeAll = () => {
    void perform(async () => {
      const { revoked } = await revokeAdminUserSessions(target.id);
      toast.success(
        revoked > 0
          ? fillTemplate(t("admin.userPanel.revokedAll"), { username: current.username, n: revoked })
          : fillTemplate(t("admin.userPanel.revokedNone"), { username: current.username }),
      );
      setMode("view");
      changed();
    }, t("admin.userPanel.revokeFailed"));
  };

  const revokeSession = async (session: AdminUserSession, deviceName: string) => {
    setEnding((prev) => new Set(prev).add(session.id));
    setDeviceError(null);
    try {
      await revokeAdminUserSession(target.id, session.id);
      toast.success(fillTemplate(t("admin.userPanel.signedOutDevice"), { device: deviceName }));
      changed();
    } catch (err) {
      setDeviceError(messageOf(err, t("admin.userPanel.revokeFailed")));
    } finally {
      setEnding((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        return next;
      });
    }
  };

  const remove = () => {
    void perform(async () => {
      const result = await deleteAdminUser(target.id);
      toast.success(fillTemplate(t("admin.userPanel.deleted"), { username: result.username || current.username }));
      onDeleted();
    }, t("admin.deleteFailed"));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const at = document.activeElement;
    if (event.shiftKey && (at === first || at === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
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
        onKeyDown={onKeyDown}
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
