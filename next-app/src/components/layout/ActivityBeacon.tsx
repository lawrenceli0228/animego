"use client";

// One page-view report per navigation, for the admin activity panel.
//
// Mounted once in the root layout, next to LocaleHint and StaleTabNotice —
// the other two components that act without being asked. It renders nothing,
// holds no state, and its whole body is an effect.
//
// WHY IT CANNOT BE DERIVED FROM SERVER LOGS. The app router serves a soft
// navigation between two already-cached routes entirely from the client: no
// document request, no API call, nothing for the server to count. A reader
// moving through five anime pages that way is one server-visible arrival and
// five real ones.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * it does not read or send the path — only which of ten coarse surfaces
//     it belongs to, so this can never become a browsing history;
//   * it does not block, retry, or read a response;
//   * it does not gate on being logged in. Most of this site's readers are
//     not, and a page-view figure that ignored them would understate the site
//     by an order of magnitude while looking precise.

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { sendActivityBeacon, surfaceForPath } from "@/lib/activityBeacon";

export function ActivityBeacon() {
  const pathname = usePathname();
  // The path this component has already reported.
  //
  // Guarding on the VALUE rather than on a "has fired" boolean is what makes
  // this correct under React's development double-invoke of effects: the
  // second run sees its own pathname already recorded and returns. A boolean
  // would need a cleanup that unsets it, which is exactly the shape that
  // double-counts instead.
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || reported.current === pathname) return;
    reported.current = pathname;
    sendActivityBeacon("page_view", surfaceForPath(pathname));
  }, [pathname]);

  return null;
}
