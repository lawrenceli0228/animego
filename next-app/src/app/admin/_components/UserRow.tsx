"use client";

// Per-row Client Component for the admin user management table.
//
// Three render modes inside the same <tr>:
//   - read mode (default): displays user fields + edit/delete buttons.
//   - edit mode: inputs for username/email + save/cancel buttons.
//   - delete-confirm mode: 2-click confirmation pattern with a 5s
//     auto-reset window (matches the legacy AdminDashboard behaviour
//     without the React Query useMutation churn).
//
// All mutations route through Server Actions in _actions/users.ts.
// useTransition tracks pending state — the UI stays interactive but the
// row is visually dimmed and inputs/buttons disabled while a mutation
// is in flight.

import { useEffect, useRef, useState, useTransition } from "react";
import { deleteAdminUser, updateAdminUser } from "../_actions/users";
import type { AdminUser } from "../_types";

interface UserRowProps {
  user: AdminUser;
}

interface EditFormState {
  username: string;
  email: string;
}

const USERNAME_MIN = 3;
const USERNAME_MAX = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONFIRM_WINDOW_MS = 5000;

function initialForm(user: AdminUser): EditFormState {
  return { username: user.username, email: user.email };
}

// Compute the minimum patch: only fields the user actually changed get
// sent. Returns null if nothing changed. Validation errors come back as
// `{ error }`; the caller decides whether to short-circuit the call.
function buildPatch(
  form: EditFormState,
  user: AdminUser,
): {
  patch: { username?: string; email?: string } | null;
  error: string | null;
} {
  const usernameTrim = form.username.trim();
  const emailTrim = form.email.trim();

  if (usernameTrim.length < USERNAME_MIN || usernameTrim.length > USERNAME_MAX) {
    return { patch: null, error: `用户名长度必须在 ${USERNAME_MIN}-${USERNAME_MAX} 字符之间` };
  }
  if (!EMAIL_RE.test(emailTrim)) {
    return { patch: null, error: "邮箱格式无效" };
  }

  const patch: { username?: string; email?: string } = {};
  if (usernameTrim !== user.username) patch.username = usernameTrim;
  if (emailTrim !== user.email) patch.email = emailTrim;

  if (Object.keys(patch).length === 0) {
    return { patch: null, error: null };
  }
  return { patch, error: null };
}

function RoleBadge({ role }: { role: string | null }) {
  if (role !== "admin") return <span style={styles.dim}>user</span>;
  return <span style={{ ...styles.badge, ...styles.badgeAdmin }}>ADMIN</span>;
}

function formatDate(iso: string): string {
  // Locale-independent YYYY-MM-DD avoids hydration drift between
  // server (UTC) and the user's browser timezone.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function UserRow({ user }: UserRowProps) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditFormState>(() => initialForm(user));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-reset the delete confirm prompt after CONFIRM_WINDOW_MS so an
  // admin who clicks "删除" then walks away doesn't accidentally
  // confirm on their next click.
  useEffect(() => {
    if (!confirmingDelete) return;
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingDelete(false);
      confirmTimerRef.current = null;
    }, CONFIRM_WINDOW_MS);
    return () => {
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
    };
  }, [confirmingDelete]);

  const startEdit = () => {
    setForm(initialForm(user));
    setConfirmingDelete(false);
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  const handleSave = () => {
    const { patch, error: validationError } = buildPatch(form, user);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (patch === null) {
      // Nothing changed — exit edit mode without a network call.
      setEditing(false);
      setError(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await updateAdminUser(user._id, patch);
        setEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "更新失败");
      }
    });
  };

  const handleDeleteClick = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setError(null);
      return;
    }
    // Second click within the window — actually delete.
    setError(null);
    startTransition(async () => {
      try {
        await deleteAdminUser(user._id);
        // Don't reset confirmingDelete — RSC re-render will drop this
        // row from the table entirely.
      } catch (err) {
        setError(err instanceof Error ? err.message : "删除失败");
        setConfirmingDelete(false);
      }
    });
  };

  const cancelDelete = () => {
    setConfirmingDelete(false);
    setError(null);
  };

  const rowStyle: React.CSSProperties = {
    ...styles.row,
    ...(editing ? styles.editingRow : null),
    ...(pending ? { opacity: 0.6, pointerEvents: "none" } : null),
  };

  return (
    <>
      <tr style={rowStyle}>
        <td style={{ ...styles.td, ...styles.titleCell }}>
          {editing ? (
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="用户名"
              style={styles.input}
              disabled={pending}
              aria-label="用户名"
            />
          ) : (
            user.username
          )}
        </td>
        <td style={styles.td}>
          {editing ? (
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="邮箱"
              style={styles.input}
              disabled={pending}
              aria-label="邮箱"
            />
          ) : (
            user.email
          )}
        </td>
        <td style={styles.td}>
          <RoleBadge role={user.role} />
        </td>
        <td style={styles.td}>{formatDate(user.createdAt)}</td>
        <td style={{ ...styles.td, ...styles.numCell }}>{user.subscriptions}</td>
        <td style={{ ...styles.td, ...styles.numCell }}>{user.followers}</td>
        <td style={styles.td}>
          <div style={styles.actions}>
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={pending}
                  style={styles.saveBtn}
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={pending}
                  style={styles.btn}
                >
                  取消
                </button>
              </>
            ) : confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  disabled={pending}
                  style={styles.confirmDeleteBtn}
                >
                  再次点击确认删除
                </button>
                <button
                  type="button"
                  onClick={cancelDelete}
                  disabled={pending}
                  style={styles.btn}
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={pending}
                  style={styles.btn}
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  disabled={pending}
                  style={styles.deleteBtn}
                >
                  删除
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {error && (
        <tr style={styles.errorRow}>
          <td colSpan={7} style={styles.errorCell}>
            {error}
          </td>
        </tr>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { background: "#15151f", borderBottom: "1px solid #1f1f2a" },
  editingRow: { background: "#1a1a26" },
  td: {
    padding: "10px 12px",
    fontSize: 13,
    color: "#cfcfdc",
    verticalAlign: "middle",
  },
  titleCell: { color: "#f4f4f8", fontWeight: 500 },
  numCell: {
    fontFeatureSettings: '"tnum"',
    textAlign: "right",
    color: "#a8a8b8",
  },
  dim: { fontSize: 12, color: "#5c5c6e" },
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 600,
  },
  badgeAdmin: { background: "#3a1f25", color: "#ff453a" },
  input: {
    padding: "5px 9px",
    borderRadius: 6,
    fontSize: 13,
    border: "1px solid #2a2a38",
    background: "#0d0d14",
    color: "#f4f4f8",
    outline: "none",
    width: "100%",
    minWidth: 140,
  },
  actions: { display: "flex", flexWrap: "wrap", gap: 6 },
  btn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#a8a8b8",
  },
  saveBtn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid rgba(10,132,255,0.4)",
    background: "rgba(10,132,255,0.12)",
    color: "#5ac8fa",
  },
  deleteBtn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid rgba(255,69,58,0.4)",
    background: "rgba(255,69,58,0.08)",
    color: "#ff453a",
  },
  confirmDeleteBtn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid #ff453a",
    background: "#ff453a",
    color: "#ffffff",
  },
  errorRow: { background: "rgba(255,69,58,0.06)" },
  errorCell: {
    padding: "8px 12px",
    fontSize: 12,
    color: "#ff453a",
    borderBottom: "1px solid #1f1f2a",
  },
};
