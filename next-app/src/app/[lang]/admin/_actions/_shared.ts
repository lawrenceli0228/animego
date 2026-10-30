// Shared types + error classes for admin Server Actions.
//
// IMPORTANT: this file has NO `"use server"` directive. Sibling files in
// _actions/ that DO have `"use server"` can only export async functions —
// Next 16 strips every non-action export from them, leaving callers with
// "module has no exports at all" errors at build time. Anything that
// isn't an async function (types, classes, helpers) belongs here.

// ─── Enrichment queue control results (EnrichmentBar) ────────────────

export interface PauseHealResult {
  paused: true;
}

export interface ResumeHealResult {
  paused: false;
}

export interface HealCnResult {
  enqueued: number;
}

export interface ReEnrichResult {
  enqueued: number;
  version: 0 | 1 | 2;
}

/**
 * `POST /api/admin/hant/backfill` (HantDriftSection).
 *
 * `enqueued` is a boolean, not a row count: the job sweeps whatever is behind
 * at the moment it wakes, so there is no batch size to report at enqueue time.
 * `message` is go-api's own sentence about what it did — surfaced verbatim so
 * a refusal ("already running") reaches the operator instead of being
 * flattened into a generic success.
 */
export interface HantBackfillResult {
  enqueued: boolean;
  message: string;
}

// ─── User CRUD result envelopes ──────────────────────────────────────

export interface AdminUserMinimal {
  _id: string;
  username: string;
  email: string;
}

export interface AdminUserFull extends AdminUserMinimal {
  role: string | null;
  createdAt: string;
}

export interface DeleteUserResult {
  deleted: true;
  username: string;
}

/**
 * A user action that did not go through (users.ts).
 *
 * The user actions return this rather than throw. In production Next sends a
 * thrown action's error to the browser as a digest only, and React rebuilds
 * it there as one fixed English sentence ("An error occurred in the Server
 * Components render…"), so no thrown message — and no status — ever reached
 * the drawer. A returned object arrives whole.
 *
 * `status` and `code` are go-api's (`ApiError`), or 400 / "VALIDATION_ERROR"
 * for a check the action makes before the network, or 0 / "NETWORK_ERROR"
 * when go-api could not be reached. `message` is go-api's English or the
 * action's own check: it tells two answers with one status apart
 * (lib/adminUserErrors.ts), and is never shown as it is. Empty for an
 * unexpected error, which is logged on the server instead.
 */
export interface UserActionFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type UserActionResult<T> = { ok: true; data: T } | UserActionFailure;

// ─── Error classes used across the action surface ────────────────────
//
// The enrichment actions throw across the React RPC boundary. We normalise
// upstream ApiError instances and unexpected throws into this named class
// so Client Components can `err instanceof EnrichmentActionError` to decide
// what to surface inline.

export class EnrichmentActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "EnrichmentActionError";
  }
}
