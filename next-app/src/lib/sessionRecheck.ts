// When a tab comes back into view, is the session behind it still there?
//
// A device can be signed out while its page sits open: from another
// device's settings page (登录设备 → 退出), by a password change, or by
// logout in another tab. go-api refuses its token on the very next request,
// but an open page makes no request until the reader does something, so it
// went on showing them signed in. useSessionRecheck asks again when the tab
// is shown or focused; these two rules decide when to ask and what the
// answer means.

/** At most one recheck per this interval, however often the tab is focused. */
export const SESSION_RECHECK_MS = 30_000;

export function dueForRecheck(now: number, lastProbeAt: number): boolean {
  return now - lastProbeAt >= SESSION_RECHECK_MS;
}

/**
 * Whether an /api/auth/me probe made through authFetch says the session has
 * ended. authFetch answers 401 whenever its refresh fails — including a
 * refresh that failed on go-api's side (5xx, 429) — so the 401 alone is not
 * enough. go-api clears the auth_hint cookie only when it refuses the
 * refresh token for good, which makes a cleared hint the verdict.
 */
export function sessionEnded(status: number, authHintStillSet: boolean): boolean {
  return status === 401 && !authHintStillSet;
}
