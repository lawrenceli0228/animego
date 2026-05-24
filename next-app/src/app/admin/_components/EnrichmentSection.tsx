"use client";

// Monolithic enrichment-management section for the single /admin page.
//
// Replaces the previous /admin/enrichment route + its URL-driven
// EnrichmentTableHeader. Everything (search, filter, sort, pagination)
// lives in local React state — there is no URL sync. That matches the
// legacy AdminDashboard.jsx UX where this section was inline on the
// admin page and refreshing the page reset its filters.
//
// Data flow:
//   server `admin/page.tsx` fetches /api/admin/enrichment?page=1 with
//   defaults and passes the result as `initial`. After mount, any
//   state change (page / q / filter / sort / order) triggers a
//   client-side fetch against the same endpoint with the new params.
//   The browser cookie carries the session, no extra auth wiring.

import { useEffect, useRef, useState, useTransition } from "react";
import { EnrichmentRow as RowComponent } from "./EnrichmentRow";
import type {
  EnrichmentFilter,
  EnrichmentRow as EnrichmentRowData,
  EnrichmentSort,
  PagedResponse,
} from "../_types";

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

const DEBOUNCE_MS = 400;

interface EnrichmentSectionProps {
  initial: PagedResponse<EnrichmentRowData>;
}

function buildApiUrl(
  page: number,
  q: string,
  filter: EnrichmentFilter | "",
  sort: EnrichmentSort,
  order: Order,
): string {
  const u = new URLSearchParams();
  u.set("page", String(page));
  if (q) u.set("q", q);
  if (filter) u.set("filter", filter);
  u.set("sort", sort);
  u.set("order", order);
  return `/api/admin/enrichment?${u.toString()}`;
}

export function EnrichmentSection({ initial }: EnrichmentSectionProps) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [filter, setFilter] = useState<EnrichmentFilter | "">("");
  const [sort, setSort] = useState<EnrichmentSort>("cachedAt");
  const [order, setOrder] = useState<Order>("desc");
  const [data, setData] = useState<PagedResponse<EnrichmentRowData>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Skip the first effect run — the server already gave us page-1 data
  // via `initial`, so refetching on mount would be wasted bytes and
  // would race with the row-level revalidation paths.
  const isFirstRun = useRef(true);

  // Debounced commit: user types in qInput, after 400ms idle (or Enter)
  // copy it into q which actually triggers the fetch.
  useEffect(() => {
    if (qInput === q) return;
    const timer = setTimeout(() => {
      setQ(qInput);
      setPage(1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput, q]);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const url = buildApiUrl(page, q, filter, sort, order);
    const abort = new AbortController();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          signal: abort.signal,
        });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const body = await res.json();
        setData({
          data: body.data ?? [],
          hasMore: body.hasMore ?? false,
          total: body.total ?? 0,
          page: body.page ?? page,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "加载失败");
      }
    });
    return () => abort.abort();
  }, [page, q, filter, sort, order]);

  const handleSortClick = (col: EnrichmentSort) => {
    if (sort === col) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(col);
      setOrder("desc");
    }
  };

  return (
    <section id="enrichment" aria-labelledby="enrichment-heading">
      <header style={styles.header}>
        <h2 id="enrichment-heading" style={styles.title}>
          数据富化记录
        </h2>
        <span style={styles.totalHint}>
          共 {data.total.toLocaleString("zh-CN")} 条
        </span>
      </header>

      <div style={styles.toolbar}>
        <form
          role="search"
          style={styles.searchForm}
          onSubmit={(e) => {
            e.preventDefault();
            setQ(qInput);
            setPage(1);
          }}
        >
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="搜索 anilistId / 罗马音 / 中文标题"
            style={styles.searchInput}
            aria-label="搜索富化记录"
          />
          {qInput && (
            <button
              type="button"
              onClick={() => {
                setQInput("");
                setQ("");
                setPage(1);
              }}
              style={styles.clearBtn}
              aria-label="清除搜索"
            >
              ×
            </button>
          )}
        </form>

        <div style={styles.filterRow}>
          {FILTERS.map((f) => (
            <button
              key={f.value || "all"}
              type="button"
              onClick={() => {
                setFilter(f.value);
                setPage(1);
              }}
              style={{
                ...styles.filterBtn,
                ...(filter === f.value ? styles.filterBtnActive : null),
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" style={styles.errorBox}>
          {error}
        </div>
      )}

      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              {SORTS.map((col) => (
                <th
                  key={col.value}
                  style={styles.th}
                  scope="col"
                  aria-sort={
                    sort === col.value
                      ? order === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => handleSortClick(col.value)}
                    style={styles.sortBtn}
                  >
                    {col.label}
                    {sort === col.value ? (
                      <span style={styles.sortArrow}>
                        {order === "asc" ? " ↑" : " ↓"}
                      </span>
                    ) : null}
                  </button>
                </th>
              ))}
              <th style={styles.th}>标记</th>
              <th style={styles.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.data.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={SORTS.length + 2}>
                  没有匹配的记录
                </td>
              </tr>
            ) : (
              data.data.map((row) => (
                <RowComponent key={row.anilistId} row={row} />
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer style={styles.pagination}>
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          style={styles.pageBtn}
        >
          ← 上一页
        </button>
        <span style={styles.pageIndicator}>
          第 {page} 页 · 共 {data.total.toLocaleString("zh-CN")} 条
        </span>
        <button
          type="button"
          onClick={() => setPage((p) => p + 1)}
          disabled={!data.hasMore}
          style={styles.pageBtn}
        >
          下一页 →
        </button>
      </footer>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: 12,
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
    color: "#e7e7ef",
  },
  totalHint: {
    fontSize: 13,
    color: "#7c7c8c",
  },
  toolbar: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 12,
  },
  searchForm: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  searchInput: {
    flex: 1,
    background: "#0d0d14",
    border: "1px solid #2a2a38",
    borderRadius: 8,
    padding: "8px 32px 8px 12px",
    color: "#e7e7ef",
    fontSize: 14,
    outline: "none",
  },
  clearBtn: {
    position: "absolute",
    right: 8,
    background: "transparent",
    border: "none",
    color: "#7c7c8c",
    fontSize: 18,
    cursor: "pointer",
    padding: "0 6px",
  },
  filterRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  filterBtn: {
    background: "#15151f",
    border: "1px solid #2a2a38",
    color: "#a8a8b8",
    fontSize: 13,
    padding: "6px 12px",
    borderRadius: 6,
    cursor: "pointer",
  },
  filterBtnActive: {
    background: "#1e3a8a",
    borderColor: "#3b82f6",
    color: "#f4f4f8",
  },
  errorBox: {
    background: "#3a0d0d",
    border: "1px solid #663030",
    color: "#ffb4b4",
    padding: "8px 12px",
    borderRadius: 6,
    marginBottom: 12,
    fontSize: 13,
  },
  tableScroll: {
    overflowX: "auto",
    border: "1px solid #1f1f2a",
    borderRadius: 8,
    background: "#15151f",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    minWidth: 900,
  },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: "1px solid #1f1f2a",
    fontSize: 12,
    fontWeight: 600,
    color: "#9090a0",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    background: "#111118",
  },
  sortBtn: {
    background: "transparent",
    border: "none",
    color: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    letterSpacing: "inherit",
    textTransform: "inherit",
    padding: 0,
    cursor: "pointer",
  },
  sortArrow: {
    color: "#3b82f6",
    marginLeft: 2,
  },
  empty: {
    padding: "24px 12px",
    textAlign: "center",
    color: "#7c7c8c",
    fontSize: 13,
  },
  pagination: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    marginTop: 12,
    padding: "8px 0",
  },
  pageBtn: {
    background: "#15151f",
    border: "1px solid #2a2a38",
    color: "#e7e7ef",
    fontSize: 13,
    padding: "6px 14px",
    borderRadius: 6,
    cursor: "pointer",
  },
  pageIndicator: {
    fontSize: 13,
    color: "#a8a8b8",
  },
};
