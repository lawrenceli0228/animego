// P6.7 — single-retry 401 helper for the ported Library + Player
// client-side fetches.
//
// Why this and not the legacy axios interceptor + queue?
// The legacy SPA's axiosClient.js dedupes concurrent 401s, queues
// in-flight requests during refresh, and dispatches an `auth:expired`
// custom event on failure. That pattern made sense when the SPA was
// the single auth surface; the ported pages live behind proxy.ts
// (server-side gate, P6.1) which already handles expired-token
// redirects on the server side. The remaining client-side path —
// in-page fetches after the page is already rendered — only needs
// the simpler "401 → refresh once → retry; on second 401 redirect
// to /login" pattern. No queue, no event bus.
//
// Usage:
//   const data = await authFetch('/api/admin/stats').then(r => r.json());
//
// Same surface as the global fetch(). On a 401, the helper attempts
// /api/auth/refresh (which reads the refreshToken cookie and sets a
// fresh `session` cookie). If refresh succeeds, the original request
// is retried once with the new cookie attached. If refresh fails,
// the browser is sent to /login?from=<current-path>.

export interface AuthFetchOptions extends RequestInit {
  /**
   * If true, skip the redirect-to-/login on the second 401 and let
   * the caller handle it. Useful for components that want to render
   * an in-page error instead of a full navigation. Default false.
   */
  skipRedirectOnFailure?: boolean;
}

let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Try refreshing the session cookie via /api/auth/refresh. Returns
 * true on success (cookie rotated, new accessToken in response),
 * false on failure (refresh cookie expired / revoked / network).
 *
 * Concurrent callers share one in-flight refresh — important when
 * the page kicks off multiple parallel fetches that all 401 at the
 * same time (e.g. EpisodeFileList + DanmakuPicker + stats poll).
 */
async function refreshSession(): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        // No body; refresh reads the refreshToken cookie directly.
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Reset so a later 401 (e.g. user has been gone for hours and
      // the rotated cookie also expired) can trigger another attempt.
      // Microtask-queued so any in-flight retries see the same
      // resolved promise before we null it.
      queueMicrotask(() => {
        inFlightRefresh = null;
      });
    }
  })();
  return inFlightRefresh;
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const from = window.location.pathname + window.location.search;
  window.location.href = `/login?from=${encodeURIComponent(from)}`;
}

/**
 * Drop-in replacement for `fetch` with single-retry 401 handling.
 *
 * - On 200/3xx/4xx (non-401) / 5xx: returns the response unchanged.
 * - On 401: kicks off (or joins) a /api/auth/refresh call. If refresh
 *   succeeds, the original request is retried once. If refresh fails
 *   (or the retried request also 401s), the browser navigates to
 *   /login?from=<current-path> — unless `skipRedirectOnFailure` is
 *   true, in which case the second 401 response is returned to the
 *   caller.
 *
 * Always sends `credentials: "same-origin"` so the session cookie
 * tags along. Override via `init.credentials` if needed.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: AuthFetchOptions = {},
): Promise<Response> {
  const merged: RequestInit = {
    credentials: "same-origin",
    ...init,
  };
  const { skipRedirectOnFailure, ...fetchInit } = merged as AuthFetchOptions;

  const res = await fetch(input, fetchInit);
  if (res.status !== 401) return res;

  const refreshed = await refreshSession();
  if (!refreshed) {
    if (skipRedirectOnFailure) return res;
    redirectToLogin();
    // Return the original 401 so callers waiting on the promise see a
    // resolved value (the navigation runs in parallel). They will
    // typically be unmounted before they can read it.
    return res;
  }

  // Refresh OK — retry the original request once.
  const retry = await fetch(input, fetchInit);
  if (retry.status === 401 && !skipRedirectOnFailure) {
    redirectToLogin();
  }
  return retry;
}

/**
 * Convenience wrapper that JSON-decodes the response. Mirrors the
 * envelope shape used elsewhere — callers get the `data` field
 * directly. Use `authFetch` for fine-grained control.
 */
export async function authFetchJson<T>(
  input: RequestInfo | URL,
  init: AuthFetchOptions = {},
): Promise<T> {
  const res = await authFetch(input, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json();
  return (body && typeof body === "object" && "data" in body
    ? body.data
    : body) as T;
}
