// What the ranking routes hand their client tree.

import type { TopItem } from "./items";
import type { TopState } from "./query";
import type { StripYears } from "./years";

export interface TopPageData {
  /** The ranking the request asked for, as the server read it. */
  state: TopState;
  items: TopItem[];
  strip: StripYears;
}
