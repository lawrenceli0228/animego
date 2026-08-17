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

// ─── Error classes used across the action surface ────────────────────
//
// Server Actions throw across the React RPC boundary. We normalise
// upstream ApiError instances and unexpected throws into these named
// classes so Client Components can `err instanceof XActionError` to
// decide what to surface inline.

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

export class UserActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "UserActionError";
  }
}
