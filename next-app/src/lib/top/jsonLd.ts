// The schema.org ItemList a ranking page carries: each show's place, its
// address and its name, in the reader's locale.
//
// Pure: no React, no DOM.

import type { Locale } from "@/lib/i18n/locale";
import { absoluteUrl } from "@/lib/seo/alternates";

export interface RankedShow {
  id: number;
  title: string;
  place: number;
}

export function topItemListJsonLd(name: string, path: string, shows: readonly RankedShow[], locale: Locale) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url: absoluteUrl(path, locale),
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    numberOfItems: shows.length,
    itemListElement: shows.map((s) => ({
      "@type": "ListItem",
      position: s.place,
      url: absoluteUrl(`/anime/${s.id}`, locale),
      name: s.title,
    })),
  };
}

/** The document as a <script> body: `<` escaped, so no title can close the script. */
export function jsonLdHtml(doc: unknown): string {
  return JSON.stringify(doc).replace(/</g, "\\u003c");
}
