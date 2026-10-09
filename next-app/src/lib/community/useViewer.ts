"use client";

// Who is reading, for the parts of the community tab that differ per reader.
//
// The page itself is one cached render for everybody, so the reader is found
// out after load, the way EpisodeComments does it: only when the non-httpOnly
// auth_hint cookie says a session probably exists (an anonymous reader costs
// no request), via /api/auth/me. `probing` is true while that is in flight so
// a signed-in reader is never shown the signed-out chrome first — see
// lib/authChrome.ts for the invariant.

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";

export interface Viewer {
  id: string;
  username: string;
  avatarUrl: string | null;
  backdropCoverUrl: string | null;
}

export interface ViewerState {
  viewer: Viewer | null;
  probing: boolean;
  /** True once the probe has answered (or was never needed). */
  settled: boolean;
}

function parseMe(body: unknown): Viewer | null {
  const data = body && typeof body === "object" ? (body as { data?: { user?: Record<string, unknown> } }).data : null;
  const user = data?.user;
  if (!user || typeof user.id !== "string" || typeof user.username !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    id: user.id,
    username: user.username,
    avatarUrl: text(user.avatarUrl),
    backdropCoverUrl: text(user.backdropCoverUrl),
  };
}

export function useViewer(): ViewerState {
  const [state, setState] = useState<ViewerState>({ viewer: null, probing: false, settled: false });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!hasAuthHint()) {
        setState({ viewer: null, probing: false, settled: true });
        return;
      }
      setState({ viewer: null, probing: true, settled: false });
      let viewer: Viewer | null = null;
      try {
        const res = await authFetch("/api/auth/me", { skipRedirectOnFailure: true });
        if (res.ok) viewer = parseMe(await res.json());
      } catch {
        /* anonymous */
      }
      if (!cancelled) setState({ viewer, probing: false, settled: true });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
