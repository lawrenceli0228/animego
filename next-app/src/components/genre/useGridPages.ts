"use client";

// The grid's pages after the first: fetched in the browser when "show more"
// is pressed (or comes near), appended, and remembered.
//
// Remembered twice. The history entry keeps how many pages were open for its
// address (lib/seasonal/batchMemory.ts, the seasonal page's), and this module
// keeps the pages themselves for the life of the document. So opening a show
// from deep in the grid and coming Back lands on the grid as it was left,
// without asking the API again. A reload asks nothing either: it renders the
// server's one page, as the server did.

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { browsePath } from "@/lib/genre/api";
import { hasPageAfter, type GenreGridData } from "@/lib/genre/grid";
import { appendUnique, toGenreItems, type GenreItem } from "@/lib/genre/items";
import { parseBrowsePage } from "@/lib/genre/overview";
import type { Lang } from "@/lib/i18n/lang";
import { batchMemory, memoryUrl, rememberedPages } from "@/lib/seasonal/batchMemory";

/** Pages kept for the life of the document, keyed by request and language. */
const PAGE_CACHE_LIMIT = 60;
const pageCache = new Map<string, GenreItem[]>();

function cacheKey(path: string, lang: Lang): string {
  return `${lang}|${path}`;
}

function remember(key: string, items: GenreItem[]): void {
  pageCache.delete(key);
  pageCache.set(key, items);
  while (pageCache.size > PAGE_CACHE_LIMIT) {
    const oldest = pageCache.keys().next().value;
    if (oldest === undefined) break;
    pageCache.delete(oldest);
  }
}

/**
 * Whether a grid has hydrated in this document yet. Until one has, a mount is
 * the hydration of the server's HTML and must render its one page, even when
 * a reload kept a history entry that remembers more (see BrowseView).
 */
let hydratedOnce = false;

interface Loaded {
  items: GenreItem[];
  /** The last page in `items`. */
  lastPage: number;
}

/** The pages a remount can restore at once from what this document already fetched. */
function restored(data: GenreGridData, lang: Lang, pages: number): Loaded {
  let loaded: Loaded = { items: data.items, lastPage: data.page };
  for (let p = data.page + 1; p < data.page + pages; p += 1) {
    const cached = pageCache.get(cacheKey(browsePath(data.filter, p), lang));
    if (!cached) break;
    loaded = { items: appendUnique(loaded.items, cached), lastPage: p };
  }
  return loaded;
}

export interface GridPages {
  items: GenreItem[];
  lastPage: number;
  hasMore: boolean;
  loading: boolean;
  /** The last fetch failed: "show more" now follows its link instead. */
  failed: boolean;
  more: () => void;
}

export function useGridPages(data: GenreGridData, lang: Lang): GridPages {
  const pathname = usePathname();
  const query = useSearchParams();
  const [loaded, setLoaded] = useState<Loaded>(() =>
    hydratedOnce && typeof window !== "undefined"
      ? restored(data, lang, rememberedPages(window.history.state, memoryUrl(pathname ?? "", query?.toString() ?? "")))
      : { items: data.items, lastPage: data.page },
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    hydratedOnce = true;
    return () => abort.current?.abort();
  }, []);

  // The history entry remembers how many pages are open, for this address.
  // Next's own entry state rides along, so this never moves the router.
  const pages = loaded.lastPage - data.page + 1;
  useEffect(() => {
    const url = memoryUrl(window.location.pathname, window.location.search);
    if (rememberedPages(window.history.state, url) === pages) return;
    window.history.replaceState({ ...window.history.state, ...batchMemory(url, pages) }, "");
  }, [pages]);

  const hasMore = hasPageAfter(data.total, loaded.lastPage);

  const more = useCallback(() => {
    if (busy.current || !hasMore) return;
    busy.current = true;
    const next = loaded.lastPage + 1;
    const path = browsePath(data.filter, next);
    const key = cacheKey(path, lang);
    const cached = pageCache.get(key);
    if (cached) {
      setLoaded((prev) => ({ items: appendUnique(prev.items, cached), lastPage: next }));
      busy.current = false;
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setFailed(false);
    fetch(path, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = parseBrowsePage(await res.json());
        const items = toGenreItems(page.rows, lang);
        remember(key, items);
        setLoaded((prev) => ({ items: appendUnique(prev.items, items), lastPage: next }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // The link under the button still leads to the page: the next press follows it.
        console.warn("[genre] next page failed:", err);
        setFailed(true);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        busy.current = false;
        setLoading(false);
      });
  }, [data.filter, hasMore, lang, loaded.lastPage]);

  return { items: loaded.items, lastPage: loaded.lastPage, hasMore, loading, failed, more };
}
