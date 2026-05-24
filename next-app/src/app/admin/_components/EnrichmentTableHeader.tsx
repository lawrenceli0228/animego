"use client";

// URL-driven toolbar for the enrichment list: search input, four
// filter buttons, and six sortable column buttons. Every interaction
// rewrites the page's search params via `router.push` so the RSC
// re-renders with the new query — there is no client-side fetch.
//
// Search uses a 400ms debounce plus Enter-to-submit. Filter / sort
// buttons commit immediately. Filter and search changes reset `page`
// to 1; sort changes preserve the current page so callers don't lose
// position when re-sorting deep into a result set.
//
// Note on the order value: the go-api accepts lowercase `asc` /
// `desc` for the `?order=` query param (case-sensitive in
// list_enrichment.go: `if p.SortOrder == "asc"`). We use lowercase
// here to match the contract — uppercase would silently default to
// DESC and look like a bug.

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { EnrichmentFilter, EnrichmentSort } from "../_types";

interface FilterButton {
  value: EnrichmentFilter | "";
  label: string;
}

const FILTERS: FilterButton[] = [
  { value: "", label: "全部" },
  { value: "needs-review", label: "待复核" },
  { value: "manually-corrected", label: "已校正" },
  { value: "unenriched", label: "未富化" },
  { value: "no-cn", label: "缺中文" },
];

interface SortButton {
  value: EnrichmentSort;
  label: string;
}

const SORTS: SortButton[] = [
  { value: "cachedAt", label: "缓存时间" },
  { value: "title_chinese", label: "中文标题" },
  { value: "title_romaji", label: "罗马音" },
  { value: "bangumi_version", label: "富化版本" },
  { value: "bangumi_score", label: "评分" },
  { value: "anilist_id", label: "AniList ID" },
];

type Order = "asc" | "desc";

const DEFAULT_SORT: EnrichmentSort = "cachedAt";
const DEFAULT_ORDER: Order = "desc";

interface EnrichmentTableHeaderProps {
  initialQuery: string;
  filter: EnrichmentFilter | "";
  sort: EnrichmentSort;
  order: Order;
}

// Build a new search-params string preserving any unrelated keys.
// Caller passes the existing params plus a patch of `key → value | null`
// (null deletes the key). Returns a query string ready for `router.push`.
function buildQueryString(
  current: URLSearchParams,
  patch: Record<string, string | null>,
): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  const str = next.toString();
  return str ? `?${str}` : "";
}

export function EnrichmentTableHeader({
  initialQuery,
  filter,
  sort,
  order,
}: EnrichmentTableHeaderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Local controlled state for the search input. Debounced commits
  // sync to the URL after 400ms idle; Enter commits immediately.
  const [query, setQuery] = useState(initialQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last URL-committed value so the debounce only fires
  // when the user actually changed something.
  const lastCommittedRef = useRef(initialQuery);

  // "Adjust state while rendering" pattern for prop → state sync
  // (back/forward changes initialQuery). React 19 bans both
  // setState-in-effect and ref-mutation-during-render, so the diff
  // sentinel must itself be useState. lastCommittedRef is mutated
  // only inside event handlers / effects below (allowed); the prop
  // sync alone is render-time.
  // ref: react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [lastInitialQuery, setLastInitialQuery] = useState(initialQuery);
  if (initialQuery !== lastInitialQuery) {
    setLastInitialQuery(initialQuery);
    setQuery(initialQuery);
    // lastCommittedRef will be re-aligned by the debounce effect's
    // own early-return on (query === initialQuery).
  }

  const commitQuery = (next: string) => {
    if (next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    const qs = buildQueryString(searchParams, {
      q: next.trim() === "" ? null : next.trim(),
      page: null, // reset to 1 on new search
    });
    router.push(qs || "?");
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitQuery(value), 400);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    commitQuery(query);
  };

  const handleFilter = (next: EnrichmentFilter | "") => {
    const qs = buildQueryString(searchParams, {
      filter: next === "" ? null : next,
      page: null,
    });
    router.push(qs || "?");
  };

  // Click cycles: same column → flip order; different column → fall
  // back to DESC default. Sort changes preserve the current page.
  const handleSort = (next: EnrichmentSort) => {
    let nextOrder: Order;
    if (sort === next) {
      nextOrder = order === "desc" ? "asc" : "desc";
    } else {
      nextOrder = DEFAULT_ORDER;
    }
    const qs = buildQueryString(searchParams, {
      sort: next === DEFAULT_SORT && nextOrder === DEFAULT_ORDER ? null : next,
      order:
        nextOrder === DEFAULT_ORDER && next === DEFAULT_SORT ? null : nextOrder,
    });
    router.push(qs || "?");
  };

  // Cleanup pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div style={styles.wrap}>
      <form onSubmit={handleSubmit} style={styles.searchRow}>
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="搜索：标题或 AniList ID"
          style={styles.searchInput}
          aria-label="搜索"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              setQuery("");
              commitQuery("");
            }}
            style={styles.clearBtn}
          >
            清除
          </button>
        )}
      </form>

      <div style={styles.filterRow} role="group" aria-label="筛选">
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value || "all"}
              type="button"
              onClick={() => handleFilter(f.value)}
              style={{
                ...styles.filterBtn,
                ...(active ? styles.filterBtnActive : null),
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div style={styles.sortRow} role="group" aria-label="排序">
        <span style={styles.sortLabel}>排序：</span>
        {SORTS.map((s) => {
          const active = sort === s.value;
          const arrow = active ? (order === "asc" ? " ▲" : " ▼") : "";
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => handleSort(s.value)}
              style={{
                ...styles.sortBtn,
                ...(active ? styles.sortBtnActive : null),
              }}
            >
              {s.label}
              {arrow}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 20,
  },
  searchRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  searchInput: {
    padding: "8px 14px",
    borderRadius: 8,
    fontSize: 13,
    border: "1px solid #2a2a38",
    background: "#15151f",
    color: "#f4f4f8",
    outline: "none",
    width: 280,
  },
  clearBtn: {
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 12,
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#a8a8b8",
    cursor: "pointer",
  },
  filterRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  filterBtn: {
    padding: "6px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#a8a8b8",
  },
  filterBtnActive: {
    borderColor: "rgba(10,132,255,0.6)",
    background: "rgba(10,132,255,0.15)",
    color: "#5ac8fa",
  },
  sortRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    alignItems: "center",
  },
  sortLabel: {
    fontSize: 12,
    color: "#7c7c8c",
    marginRight: 4,
  },
  sortBtn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#9090a0",
    fontFeatureSettings: '"tnum"',
  },
  sortBtnActive: {
    borderColor: "rgba(90,200,250,0.5)",
    color: "#5ac8fa",
    background: "rgba(90,200,250,0.08)",
  },
};
