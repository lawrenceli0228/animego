"use server";

// Server Actions for the admin user management surface. Mirrors legacy
// `client/src/api/admin.api.js` createUser / updateUser / deleteUser,
// but re-shapes the call sites as Server Functions so the Client
// Components (CreateUserForm, UserRow) can invoke them directly without
// React Query.
//
// All three endpoints sit behind RequireAuth+RequireAdmin in go-api
// (see docs/migration/P7-DESIGN.md §5). `apiMutate` forwards the
// browser session cookie, so authentication just works.
//
// Revalidation strategy — per P7-DESIGN §5:
//   POST   /api/admin/users           → admin:users (+ path)
//   PATCH  /api/admin/users/:id       → admin:users + user:profile:{id} (+ path)
//   DELETE /api/admin/users/:id       → admin:users + user:profile:{id} (+ path)

import { revalidatePath, revalidateTag } from "next/cache";
import { ApiError, apiMutate } from "@/lib/api";
import { getDict, type Dict } from "@/lib/i18n";
import {
  type AdminUserFull,
  type AdminUserMinimal,
  type DeleteUserResult,
  UserActionError,
} from "./_shared";

function toActionError(action: string, err: unknown): UserActionError {
  if (err instanceof UserActionError) return err;
  if (err instanceof ApiError) {
    // Server-side breadcrumb for ops; the client only sees the
    // normalised message below.
    console.error(`[admin:${action}] ${err.code} ${err.status}`, err.message);
    return new UserActionError(err.code, err.message, err.status);
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  console.error(`[admin:${action}] unexpected`, err);
  return new UserActionError("UNEXPECTED", message, 500);
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
  if (trimmed === "") {
    throw new UserActionError(
      "VALIDATION_ERROR",
      dict.admin.userActions.usernameEmpty,
      400,
    );
  }
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    throw new UserActionError(
      "VALIDATION_ERROR",
      dict.admin.userActions.usernameMinMax
        .replace("{{min}}", String(USERNAME_MIN))
        .replace("{{max}}", String(USERNAME_MAX)),
      400,
    );
  }
  return trimmed;
}

function validateEmail(raw: string, dict: Dict): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new UserActionError(
      "VALIDATION_ERROR",
      dict.admin.userActions.emailEmpty,
      400,
    );
  }
  if (!EMAIL_RE.test(trimmed)) {
    throw new UserActionError(
      "VALIDATION_ERROR",
      dict.admin.userActions.emailInvalid,
      400,
    );
  }
  return trimmed;
}

function validatePassword(raw: string, dict: Dict): string {
  if (raw === "") {
    throw new UserActionError(
      "VALIDATION_ERROR",
      dict.admin.userActions.passwordEmpty,
      400,
    );
  }
  if (raw.length < PASSWORD_MIN) {
    throw new UserActionError(
      "VALIDATION_ERROR",
      dict.admin.userActions.passwordMinLen.replace(
        "{{len}}",
        String(PASSWORD_MIN),
      ),
      400,
    );
  }
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
}): Promise<AdminUserMinimal> {
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
    return created;
  } catch (err) {
    throw toActionError("createAdminUser", err);
  }
}

/**
 * POST /api/admin/users/:id/password — admin sets a new password for any
 * account. go-api bcrypt-hashes it (cost 10) and nulls the target's
 * refresh_token, invalidating their existing sessions so they must
 * re-login with the new password. Returns { success: true }.
 *
 * No user-list revalidation — password is not a displayed field — but we
 * bust user:profile:{id} in case any per-user page keys on session state.
 */
export async function setAdminUserPassword(
  userId: string,
  password: string,
): Promise<void> {
  try {
    const dict = await getDict();
    if (!userId) {
      throw new UserActionError(
        "VALIDATION_ERROR",
        dict.admin.userActions.missingUserId,
        400,
      );
    }
    const pw = validatePassword(password, dict);
    await apiMutate<{ success: boolean }>(
      `/api/admin/users/${encodeURIComponent(userId)}/password`,
      "POST",
      { body: { password: pw } },
    );
    revalidateTag(`user:profile:${userId}`, "max");
  } catch (err) {
    throw toActionError("setAdminUserPassword", err);
  }
}

/**
 * PATCH /api/admin/users/:id — update username and/or email. Only
 * fields the caller passes are sent to the backend (backend treats
 * undefined as no-op). Empty strings are rejected as validation
 * errors; pass the existing value unchanged if you don't want to edit
 * that field.
 *
 * Revalidation:
 *   - tag `admin:users`
 *   - tag `user:profile:{id}` (any per-user profile cached page)
 *   - path `/admin/users`
 */
export async function updateAdminUser(
  userId: string,
  patch: { username?: string; email?: string },
): Promise<AdminUserFull> {
  try {
    const dict = await getDict();
    if (!userId) {
      throw new UserActionError(
        "VALIDATION_ERROR",
        dict.admin.userActions.missingUserId,
        400,
      );
    }
    const body: { username?: string; email?: string } = {};
    if (patch.username !== undefined) {
      body.username = validateUsername(patch.username, dict);
    }
    if (patch.email !== undefined) {
      body.email = validateEmail(patch.email, dict);
    }
    if (Object.keys(body).length === 0) {
      throw new UserActionError(
        "VALIDATION_ERROR",
        dict.admin.userActions.noUpdateFields,
        400,
      );
    }

    const updated = await apiMutate<AdminUserFull>(
      `/api/admin/users/${encodeURIComponent(userId)}`,
      "PATCH",
      { body },
    );
    revalidateTag("admin:users", "max");
    revalidateTag(`user:profile:${userId}`, "max");
    revalidatePath("/admin");
    return updated;
  } catch (err) {
    throw toActionError("updateAdminUser", err);
  }
}

/**
 * DELETE /api/admin/users/:id — delete a user. Returns
 * `{deleted: true, username}`. Backend rejects self-delete with 400
 * "cannot delete self"; we surface that as a UserActionError.
 *
 * Revalidation:
 *   - tag `admin:users`
 *   - tag `user:profile:{id}`
 *   - path `/admin/users`
 */
export async function deleteAdminUser(
  userId: string,
): Promise<DeleteUserResult> {
  try {
    const dict = await getDict();
    if (!userId) {
      throw new UserActionError(
        "VALIDATION_ERROR",
        dict.admin.userActions.missingUserId,
        400,
      );
    }
    const result = await apiMutate<DeleteUserResult>(
      `/api/admin/users/${encodeURIComponent(userId)}`,
      "DELETE",
    );
    revalidateTag("admin:users", "max");
    revalidateTag(`user:profile:${userId}`, "max");
    revalidatePath("/admin");
    return result;
  } catch (err) {
    throw toActionError("deleteAdminUser", err);
  }
}
