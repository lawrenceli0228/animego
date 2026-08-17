"use client";

// Re-export shim for the real ManualSearch in the Player surface. Library's
// RematchDialog still imports from this path; the underlying component is now
// owned by `@/app/[lang]/player/_components/ManualSearch.tsx` (P6.6).
//
// The named-as-default re-export keeps RematchDialog's dynamic import
// (`import("./ManualSearchPlaceholder").then((m) => m.ManualSearchPlaceholder)`)
// resolving without touching that call site, while the new code can pull the
// canonical name.

export { ManualSearch as ManualSearchPlaceholder } from "@/app/[lang]/player/_components/ManualSearch";
export { ManualSearch as default } from "@/app/[lang]/player/_components/ManualSearch";
export { ManualSearch } from "@/app/[lang]/player/_components/ManualSearch";
export type {
  ManualSearchProps,
  AnimeSearchResult,
} from "@/app/[lang]/player/_components/ManualSearch";
