"use client";

// Tears down a server-rendered, account-specific block the moment the user
// signs out — without navigating.
//
// Why this exists: logout is deliberately non-navigating (Navbar clears its
// own state and stays put), so every server-rendered node on screen keeps
// showing whatever the previous session produced. For the Continue Watching
// grid that is the user's covers, titles and episode progress. On a shared
// machine the next person sees a page whose navbar says "Log in / Register"
// while a stranger's watch list is still listed underneath it.
//
// SubscriptionSetProvider already zeroes the poster-corner ticks off the same
// signal; this closes the larger surface. Both read SIGNED_OUT_EVENT rather
// than polling the cookie, because the cookie clears before the request that
// cleared it settles and nothing would re-render on that alone.
//
// The sign-out is remembered for the rest of the document, not just announced
// (hasSignedOutHere): browser back / forward remounts cached pages without a
// request, and a block mounted after the event would otherwise start out
// showing the previous reader's data again.
//
// Both bodies are rendered on the server and handed in as props — the client
// only picks between them, so nothing account-specific is fetched here and no
// server component has to become a client component to use this.

import { useSyncExternalStore, type ReactNode } from "react";
import { hasSignedOutHere, subscribeToSignedOut } from "./subscriptionSetState";

interface SignedOutGateProps {
  /** The authenticated body. Shown until a sign-out lands. */
  children: ReactNode;
  /** What an anonymous visitor would have seen. Shown after sign-out. */
  signedOut: ReactNode;
}

// The server rendered for whoever was signed in when the page was built, and
// hydration agrees with it; the client only ever learns of a sign-out after.
const notSignedOutOnServer = () => false;

export default function SignedOutGate({
  children,
  signedOut,
}: SignedOutGateProps): React.ReactElement {
  const gone = useSyncExternalStore(subscribeToSignedOut, hasSignedOutHere, notSignedOutOnServer);
  return <>{gone ? signedOut : children}</>;
}
