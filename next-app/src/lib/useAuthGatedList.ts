import { useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";

// Client-side auth-gated list fetch — the shared engine behind the homepage
// "islands" (ContinueWatching, ActivityFeed). These sections render per-user
// data, so they CANNOT be server-rendered into the homepage HTML: that HTML is
// edge-cached by Cloudflare and shared across all anonymous visitors, and a
// server-rendered watch list would leak one user's data to everyone (cache
// poisoning). Moving the fetch to the client keeps the cached shell anonymous.
//
// Mirrors the gate Navbar / SubscriptionButton already use: read the non-secret
// `auth_hint` cookie first so an anonymous load fires ZERO auth requests, then
// authFetch (which self-heals an expired 15-min session via the refresh cookie).
//
// State machine (the consuming island maps each status to UI):
//
//   mount
//     │
//     ├─ initial render (server + first client paint) ──▶ "loading"
//     │                                                    (neutral skeleton;
//     │                                                     this is what lands
//     │                                                     in the cached HTML)
//     │
//     └─ useEffect ─┬─ no auth_hint ──────────────────▶ "anonymous" (CTA stub)
//                   │
//                   └─ auth_hint present ─ authFetch ─┬─ ok  ─▶ "ready" + items
//                                                     └─ 401 / error ─▶ "anonymous"
//
// "loading" is deterministic and user-independent on purpose: every visitor's
// first paint is the same skeleton, so the prerendered/cached HTML never
// differs by user. hasAuthHint() only resolves client-side (reads
// document.cookie), so the swap to stub/data always happens post-hydration.

export type AuthGatedStatus = "loading" | "anonymous" | "ready";

export interface AuthGatedListResult<T> {
  status: AuthGatedStatus;
  items: T[];
}

/**
 * Unwrap an API list response into its item array.
 *
 * Handles both envelope shapes the islands hit:
 *   - `/api/subscriptions` → `{ data: WatchingItem[] }`
 *   - `/api/feed`          → `{ data: FeedItem[], hasMore, nextPage }`
 * and tolerates a bare array. Anything malformed (null, primitive, non-array
 * `data`) degrades to `[]`, so a weird body renders an empty/hidden section
 * instead of throwing into the React tree.
 *
 * Exported so the contract is unit-tested directly (the hook's React wiring is
 * covered by the homepage E2E), mirroring useDandanComments' dandanToArtplayer.
 */
export function unwrapList(body: unknown): unknown[] {
  const raw =
    body && typeof body === "object" && "data" in body
      ? (body as { data: unknown }).data
      : body;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Fetch a per-user list on the client, gated on the `auth_hint` cookie.
 *
 * Unwraps the standard `{ data: [...] }` envelope (and tolerates a bare array),
 * so both `/api/subscriptions` and `/api/feed` (whose body is
 * `{ data, hasMore, nextPage }`) yield their item array directly.
 *
 * Any failure — no hint, 401 after a refresh attempt, network blip, malformed
 * body — collapses to `"anonymous"`, which the islands render as the logged-out
 * CTA stub. That matches the prior server-side behavior (treat any error as
 * "show the login stub") and never throws into the React tree.
 *
 * @param url Same-origin API path (e.g. `/api/feed?page=1`).
 */
export function useAuthGatedList<T>(url: string): AuthGatedListResult<T> {
  const [result, setResult] = useState<AuthGatedListResult<T>>({
    status: "loading",
    items: [],
  });

  useEffect(() => {
    let cancelled = false;

    // Resolve the gate + fetch inside an async helper so no setState runs
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    const resolve = async () => {
      // No hint → anonymous, with zero network requests (an anonymous homepage
      // load must not touch the auth-gated API at all).
      if (!hasAuthHint()) {
        if (!cancelled) setResult({ status: "anonymous", items: [] });
        return;
      }
      try {
        // skipRedirectOnFailure: a genuinely-expired visitor renders the stub
        // in place, NOT bounced to /login from the homepage.
        const res = await authFetch(url, { skipRedirectOnFailure: true });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (cancelled) return;
        setResult({ status: "ready", items: unwrapList(body) as T[] });
      } catch {
        if (!cancelled) setResult({ status: "anonymous", items: [] });
      }
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return result;
}
