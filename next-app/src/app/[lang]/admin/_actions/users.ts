"use server";

// Server Actions for the admin user management surface. Mirrors legacy
// `client/src/api/admin.api.js` createUser / updateUser / deleteUser,
// but re-shapes the call sites as Server Functions so the Client
// Components (CreateUserForm, the user detail drawer) can invoke them
// directly without React Query.
//
// Every endpoint here sits behind RequireAuth+RequireAdmin in go-api
// (see docs/migration/P7-DESIGN.md §5). `apiMutate` forwards the
// browser session cookie, so authentication just works.
//
// Every action returns a UserActionResult (_shared.ts) and never throws on
// purpose: in production Next hands a thrown action's error to the browser as
// a digest, and the caller only ever saw React's generic sentence in place of
// what went wrong. A failure carries go-api's status, code and message, and
// the client picks its own words from them (lib/adminUserErrors.ts).
//
// Revalidation strategy — per P7-DESIGN §5, and only after a success:
//   POST   /api/admin/users                      → admin:users (+ path)
//   PATCH  /api/admin/users/:id                  → admin:users + user:profile:{id} (+ path)
//   DELETE /api/admin/users/:id                  → admin:users + user:profile:{id} (+ path)
//   DELETE /api/admin/users/:id/sessions[/:sid]  → admin:users + user:profile:{id} (+ path)
//
// Who may call these is decided by go-api, on every request: each action
// forwards the caller's own session (apiMutate's default, never anonymous),
// and go-api re-checks it — RequireAuth + RequireAdmin, and the session must
// still be live — before anything changes. A non-admin, or an admin whose
// session has been ended, gets go-api's 401/403 back as a failure with that
// status, and nothing is revalidated.

import { revalidatePath, revalidateTag } from "next/cache";
import { ApiError, apiMutate } from "@/lib/api";
import { getDict, type Dict } from "@/lib/i18n";
import { UUID } from "@/lib/people/edit/review";
import type { AdminRevokeSessionsResult } from "../_types/users";
import type {
  AdminUserFull,
  AdminUserMinimal,
  DeleteUserResult,
  UserActionFailure,
  UserActionResult,
} from "./_shared";

/** A check an action makes before the network; its message is the dictionary's. */
class Refusal extends Error {}

function toFailure(action: string, err: unknown): UserActionFailure {
  if (err instanceof Refusal) {
    return { ok: false, status: 400, code: "VALIDATION_ERROR", message: err.message };
  }
  if (err instanceof ApiError) {
    // Server-side breadcrumb for ops. go-api's message goes back too: it is
    // what tells two answers with the same status apart.
    console.error(`[admin:${action}] ${err.code} ${err.status}`, err.message);
    return { ok: false, status: err.status, code: err.code, message: err.message };
  }
  // Anything else is ours, and may name internals: logged here, not sent.
  console.error(`[admin:${action}] unexpected`, err);
  return { ok: false, status: 500, code: "UNEXPECTED", message: "" };
}

// Matches the legacy validation in client/src/pages/AdminDashboard.jsx
// (the form short-circuits if any field is empty) plus a 6-char
// password floor; backend allows any non-empty string but we surface a
// friendlier UX-side guard before the network round-trip.
const USERNAME_MIN = 3;
const USERNAME_MAX = 50;
const PASSWORD_MIN = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUsername(raw: string, dict: Dict): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Refusal(dict.admin.userActions.usernameEmpty);
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    throw new Refusal(
      dict.admin.userActions.usernameMinMax
        .replace("{{min}}", String(USERNAME_MIN))
        .replace("{{max}}", String(USERNAME_MAX)),
    );
  }
  return trimmed;
}

function validateEmail(raw: string, dict: Dict): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Refusal(dict.admin.userActions.emailEmpty);
  if (!EMAIL_RE.test(trimmed)) throw new Refusal(dict.admin.userActions.emailInvalid);
  return trimmed;
}

function validatePassword(raw: string, dict: Dict): string {
  if (raw === "") throw new Refusal(dict.admin.userActions.passwordEmpty);
  if (raw.length < PASSWORD_MIN) {
    throw new Refusal(dict.admin.userActions.passwordMinLen.replace("{{len}}", String(PASSWORD_MIN)));
  }
  return raw;
}

function requireUserId(raw: string, dict: Dict): string {
  if (!raw) throw new Refusal(dict.admin.userActions.missingUserId);
  return raw;
}

/**
 * POST /api/admin/users — create a new user. Returns the new user's
 * `{_id, username, email}` per the go-api contract. Email is
 * lowercased server-side; we send what the admin typed.
 *
 * Revalidation:
 *   - tag `admin:users` (any user list cached anywhere)
 *   - path `/admin/users` (the table page)
 */
export async function createAdminUser(data: {
  username: string;
  email: string;
  password: string;
}): Promise<UserActionResult<AdminUserMinimal>> {
  try {
    const dict = await getDict();
    const username = validateUsername(data.username, dict);
    const email = validateEmail(data.email, dict);
    const password = validatePassword(data.password, dict);

    const created = await apiMutate<AdminUserMinimal>(
      "/api/admin/users",
      "POST",
      { body: { username, email, password } },
    );
    revalidateTag("admin:users", "max");
    revalidatePath("/admin");
    return { ok: true, data: created };
  } catch (err) {
    return toFailure("createAdminUser", err);
  }
}

/**
 * POST /api/admin/users/:id/password — admin sets a new password for any
 * account. go-api bcrypt-hashes it (cost 10). Succeeds with `data: null`.
 *
 * The new password also ends every one of the target's sessions (go-api
 * migration 0052), and an access token is refused once its session is gone,
 * so the account is signed out everywhere on its next request — except with
 * an access token minted before tokens named their session, which go-api
 * cannot look up and which lasts until it expires (15m by default).
 *
 * No user-list revalidation — password is not a displayed field — but we
 * bust user:profile:{id} in case any per-user page keys on session state.
 */
export async function setAdminUserPassword(
  userId: string,
  password: string,
): Promise<UserActionResult<null>> {
  try {
    const dict = await getDict();
    const id = requireUserId(userId, dict);
    const pw = validatePassword(password, dict);
    await apiMutate<{ success: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}/password`,
      "POST",
      { body: { password: pw } },
    );
    revalidateTag(`user:profile:${id}`, "max");
    return { ok: true, data: null };
  } catch (err) {
    return toFailure("setAdminUserPassword", err);
  }
}

/**
 * PATCH /api/admin/users/:id — update username and/or email. Only
 * fields the caller passes are sent to the backend (backend treats
 * undefined as no-op). Empty strings are refused before the network;
 * pass the existing value unchanged if you don't want to edit that field.
 *
 * Revalidation:
 *   - tag `admin:users`
 *   - tag `user:profile:{id}` (any per-user profile cached page)
 *   - path `/admin/users`
 */
export async function updateAdminUser(
  userId: string,
  patch: { username?: string; email?: string },
): Promise<UserActionResult<AdminUserFull>> {
  try {
    const dict = await getDict();
    const id = requireUserId(userId, dict);
    const body: { username?: string; email?: string } = {};
    if (patch.username !== undefined) {
      body.username = validateUsername(patch.username, dict);
    }
    if (patch.email !== undefined) {
      body.email = validateEmail(patch.email, dict);
    }
    if (Object.keys(body).length === 0) {
      throw new Refusal(dict.admin.userActions.noUpdateFields);
    }

    const updated = await apiMutate<AdminUserFull>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      "PATCH",
      { body },
    );
    revalidateTag("admin:users", "max");
    revalidateTag(`user:profile:${id}`, "max");
    revalidatePath("/admin");
    return { ok: true, data: updated };
  } catch (err) {
    return toFailure("updateAdminUser", err);
  }
}

/**
 * DELETE /api/admin/users/:id — delete a user. Returns
 * `{deleted: true, username}`. Backend refuses self-delete with 400
 * "Cannot delete yourself", which comes back as a failure.
 *
 * Revalidation:
 *   - tag `admin:users`
 *   - tag `user:profile:{id}`
 *   - path `/admin/users`
 */
export async function deleteAdminUser(
  userId: string,
): Promise<UserActionResult<DeleteUserResult>> {
  try {
    const dict = await getDict();
    const id = requireUserId(userId, dict);
    const result = await apiMutate<DeleteUserResult>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      "DELETE",
    );
    revalidateTag("admin:users", "max");
    revalidateTag(`user:profile:${id}`, "max");
    revalidatePath("/admin");
    return { ok: true, data: result };
  } catch (err) {
    return toFailure("deleteAdminUser", err);
  }
}

// Both ids are uuids in go-api (users.id, user_sessions.id) and the session
// routes carry them in the path, so anything else is refused here rather
// than forwarded.
function validateUserUuid(raw: string, dict: Dict): string {
  const id = requireUserId(raw, dict);
  if (!UUID.test(id)) throw new Refusal(dict.admin.userPanel.invalidUserId);
  return id;
}

function validateSessionUuid(raw: string, dict: Dict): string {
  if (!raw || !UUID.test(raw)) throw new Refusal(dict.admin.userPanel.invalidSessionId);
  return raw;
}

// The list's 最近设备 column reads the newest live session, so ending one
// changes the list; user:profile:{id} for the reason setAdminUserPassword
// busts it — anything keyed on the account's session state.
function revalidateAfterSessions(userId: string): void {
  revalidateTag("admin:users", "max");
  revalidateTag(`user:profile:${userId}`, "max");
  revalidatePath("/admin");
}

/**
 * DELETE /api/admin/users/:id/sessions — sign the account out everywhere, in
 * one go-api transaction. Returns `{ revoked }`: how many live sessions it
 * ended, 0 when there were none. Expired session rows are deleted as well but
 * not counted, and a refresh token from before per-device sessions is cleared
 * but not counted either — the device list never showed either of them.
 *
 * Takes effect on each device's next request rather than when its access
 * token expires: an access token names its session, and go-api refuses it
 * once the session is gone.
 *
 * go-api answers 400 when the target is the calling admin — their own
 * devices are ended from /settings, which keeps the current one — and 404
 * when the account no longer exists.
 */
export async function revokeAdminUserSessions(
  userId: string,
): Promise<UserActionResult<AdminRevokeSessionsResult>> {
  try {
    const dict = await getDict();
    const id = validateUserUuid(userId, dict);
    const result = await apiMutate<AdminRevokeSessionsResult>(
      `/api/admin/users/${encodeURIComponent(id)}/sessions`,
      "DELETE",
    );
    revalidateAfterSessions(id);
    return { ok: true, data: result };
  } catch (err) {
    return toFailure("revokeAdminUserSessions", err);
  }
}

/**
 * DELETE /api/admin/users/:id/sessions/:sessionId — sign out one device.
 * Returns `{ revoked: 1 }`. 404 when the session is not this account's or is
 * already gone; the same 400 for the calling admin as above.
 */
export async function revokeAdminUserSession(
  userId: string,
  sessionId: string,
): Promise<UserActionResult<AdminRevokeSessionsResult>> {
  try {
    const dict = await getDict();
    const id = validateUserUuid(userId, dict);
    const sid = validateSessionUuid(sessionId, dict);
    const result = await apiMutate<AdminRevokeSessionsResult>(
      `/api/admin/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}`,
      "DELETE",
    );
    revalidateAfterSessions(id);
    return { ok: true, data: result };
  } catch (err) {
    return toFailure("revokeAdminUserSession", err);
  }
}
