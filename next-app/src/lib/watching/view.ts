// What the 全部在追 page (/watching) shows, decided from the watching list
// the page read on the server with the reader's cookie.
//
// The route is behind the sign-in gate in proxy.ts, so an anonymous visitor
// never reaches the render. What can still happen here is the API refusing a
// session the proxy accepted (signed out somewhere else, say) — sent to log in,
// as the gate would have — or the API failing outright, which is said as such
// rather than shown as an empty list: "you are not watching anything" would be
// a false statement about the reader's account.
//
// Pure: no React, no DOM.

export type WatchingPageState = "list" | "empty" | "unavailable" | "signed-out";

interface WatchingRead {
  loggedOut: boolean;
  unavailable: boolean;
  items: readonly unknown[];
}

export function watchingPageState(read: WatchingRead): WatchingPageState {
  if (read.unavailable) return "unavailable";
  if (read.loggedOut) return "signed-out";
  return read.items.length > 0 ? "list" : "empty";
}

/**
 * The page wears the colour of the first show on it that has one — the one
 * the reader touched most recently. Neutral when none does (or the list is
 * empty), the same rule the homepage hero follows for its first slide.
 */
export function watchingPageHue(cards: ReadonlyArray<{ hue: number | null }>): number | null {
  return cards.find((c) => c.hue !== null)?.hue ?? null;
}
