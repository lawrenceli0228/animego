// Tiny window-event bus for cross-component subscription state sync.
//
// SubscriptionButton owns the writes (mutations against /api/subscriptions).
// EpisodesGrid only reads — it needs to know the latest currentEpisode /
// status so it can paint per-cell watched / current highlighting in sync
// with the +/− counter clicks. Rather than lifting state up to a shared
// parent (the page.tsx RSC can't hold client state) we use a window
// CustomEvent bus: SubscriptionButton emits after every successful
// probe / create / patch / delete, EpisodesGrid listens.
//
// The bus deliberately stays dumb: no cache, no probe, no async. Each
// listener bootstraps its own state via authFetch on mount, then keeps
// it fresh via the broadcasts.

export type SubStatus =
  | "watching"
  | "completed"
  | "plan_to_watch"
  | "dropped";

export interface SubscriptionDoc {
  status: SubStatus;
  currentEpisode: number;
  score: number | null;
}

export interface SubscriptionChangeDetail {
  anilistId: number;
  // null = the user removed the subscription (DELETE response) or signed out.
  sub: SubscriptionDoc | null;
}

const EVENT_NAME = "animego:subscription:change";

export function broadcastSubscription(detail: SubscriptionChangeDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SubscriptionChangeDetail>(EVENT_NAME, { detail }),
  );
}

export function subscribeToBus(
  handler: (detail: SubscriptionChangeDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const ce = e as CustomEvent<SubscriptionChangeDetail>;
    if (ce.detail) handler(ce.detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
