import Link from "next/link";
import { apiGetPaged, ApiError } from "@/lib/api";
import { EnrichmentRow } from "../_components/EnrichmentRow";
import { EnrichmentTableHeader } from "../_components/EnrichmentTableHeader";
import type {
  EnrichmentFilter,
  EnrichmentRow as EnrichmentRowData,
  EnrichmentSort,
} from "../_types";

// Server Component — the enrichment management page is fully URL-driven.
// Search, filter, sort, pagination all flow through search params so
// shareable URLs and back/forward navigation behave naturally.
//
// The go-api endpoint at /api/admin/enrichment owns the sort allow-list
// (see go-api/internal/admin/list_enrichment.go enrichmentSortColumns),
// so this page only forwards validated names — anything outside the
// allow-list is dropped and the request falls back to the default
// (cachedAt DESC).

const VALID_FILTERS: ReadonlyArray<EnrichmentFilter> = [
  "needs-review",
  "manually-corrected",
  "unenriched",
  "no-cn",
];

const VALID_SORTS: ReadonlyArray<EnrichmentSort> = [
  "cachedAt",
  "title_chinese",
  "title_romaji",
  "bangumi_version",
  "bangumi_score",
  "anilist_id",
];

type Order = "asc" | "desc";

interface ParsedParams {
  page: number;
  q: string;
  filter: EnrichmentFilter | "";
  sort: EnrichmentSort;
  order: Order;
}

function parseSearchParams(raw: {
  page?: string | string[];
  q?: string | string[];
  filter?: string | string[];
  sort?: string | string[];
  order?: string | string[];
}): ParsedParams {
  // Search params can arrive as string | string[] | undefined when the
  // user supplies repeated keys. We always want the first scalar.
  const pick = (v: string | string[] | undefined): string =>
    Array.isArray(v) ? v[0] ?? "" : v ?? "";

  const pageRaw = pick(raw.page);
  const pageNum = parseInt(pageRaw, 10);
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1;

  const q = pick(raw.q).trim();

  const filterRaw = pick(raw.filter);
  const filter: EnrichmentFilter | "" =
    VALID_FILTERS.includes(filterRaw as EnrichmentFilter)
      ? (filterRaw as EnrichmentFilter)
      : "";

  const sortRaw = pick(raw.sort);
  const sort: EnrichmentSort = VALID_SORTS.includes(sortRaw as EnrichmentSort)
    ? (sortRaw as EnrichmentSort)
    : "cachedAt";

  const orderRaw = pick(raw.order).toLowerCase();
  const order: Order = orderRaw === "asc" ? "asc" : "desc";

  return { page, q, filter, sort, order };
}

function buildApiQuery(p: ParsedParams): string {
  const params = new URLSearchParams();
  params.set("page", String(p.page));
  if (p.q) params.set("q", p.q);
  if (p.filter) params.set("filter", p.filter);
  params.set("sort", p.sort);
  params.set("order", p.order);
  return params.toString();
}

// Build a URL-safe href that preserves the current search params plus
// a patch. Used by the pagination links so `?q=foo&filter=no-cn` is
// carried across page navigations.
function pageHref(
  params: ParsedParams,
  patch: Partial<ParsedParams>,
): string {
  const u = new URLSearchParams();
  const merged = { ...params, ...patch };
  if (merged.page > 1) u.set("page", String(merged.page));
  if (merged.q) u.set("q", merged.q);
  if (merged.filter) u.set("filter", merged.filter);
  if (merged.sort !== "cachedAt") u.set("sort", merged.sort);
  if (merged.order !== "desc") u.set("order", merged.order);
  const s = u.toString();
  return s ? `/admin/enrichment?${s}` : "/admin/enrichment";
}

export const metadata = {
  title: "数据富化记录 — 管理后台",
};

interface PageProps {
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
    filter?: string | string[];
    sort?: string | string[];
    order?: string | string[];
  }>;
}

export default async function EnrichmentListPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const parsed = parseSearchParams(raw);
  const query = buildApiQuery(parsed);

  let listError: string | null = null;
  let listData: {
    data: EnrichmentRowData[];
    total: number;
    hasMore: boolean;
    page: number;
  } | null = null;

  try {
    const res = await apiGetPaged<EnrichmentRowData>(
      `/api/admin/enrichment?${query}`,
      { cache: "no-store" },
    );
    listData = {
      data: res.data,
      total: res.total,
      hasMore: res.hasMore,
      page: res.page,
    };
  } catch (err) {
    listError =
      err instanceof ApiError
        ? `${err.code}: ${err.message}`
        : "加载失败";
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h2 style={styles.title}>数据富化记录</h2>
        {listData && (
          <span style={styles.totalHint}>
            共 {listData.total.toLocaleString("zh-CN")} 条
          </span>
        )}
      </header>

      <EnrichmentTableHeader
        initialQuery={parsed.q}
        filter={parsed.filter}
        sort={parsed.sort}
        order={parsed.order}
      />

      {listError && (
        <div style={styles.errorBox} role="alert">
          {listError}
        </div>
      )}

      {listData && (
        <>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>AniList ID</th>
                  <th style={styles.th}>罗马音</th>
                  <th style={styles.th}>中文标题</th>
                  <th style={styles.th}>BGM ID</th>
                  <th style={styles.th}>富化版本</th>
                  <th style={styles.th}>评分</th>
                  <th style={styles.th}>标记</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {listData.data.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={styles.emptyCell}>
                      没有记录
                    </td>
                  </tr>
                ) : (
                  listData.data.map((row) => (
                    <EnrichmentRow key={row.anilistId} row={row} />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <nav style={styles.pageRow} aria-label="分页">
            {parsed.page > 1 ? (
              <Link
                href={pageHref(parsed, { page: parsed.page - 1 })}
                style={styles.pageBtn}
              >
                上一页
              </Link>
            ) : (
              <span style={{ ...styles.pageBtn, ...styles.pageBtnDisabled }}>
                上一页
              </span>
            )}
            <span style={styles.pageIndicator}>第 {parsed.page} 页</span>
            {listData.hasMore ? (
              <Link
                href={pageHref(parsed, { page: parsed.page + 1 })}
                style={styles.pageBtn}
              >
                下一页
              </Link>
            ) : (
              <span style={{ ...styles.pageBtn, ...styles.pageBtnDisabled }}>
                下一页
              </span>
            )}
          </nav>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: 16,
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: "#f4f4f8",
    margin: 0,
  },
  totalHint: {
    fontSize: 12,
    color: "#7c7c8c",
  },
  errorBox: {
    padding: "12px 16px",
    background: "rgba(255,69,58,0.08)",
    border: "1px solid rgba(255,69,58,0.3)",
    borderRadius: 8,
    color: "#ff453a",
    fontSize: 13,
  },
  tableWrap: {
    overflowX: "auto",
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    fontSize: 11,
    fontWeight: 700,
    color: "#7c7c8c",
    textTransform: "uppercase",
    letterSpacing: 1,
    borderBottom: "1px solid #1f1f2a",
    background: "#111118",
  },
  emptyCell: {
    padding: "32px 12px",
    fontSize: 13,
    color: "#5c5c6e",
    textAlign: "center",
  },
  pageRow: {
    display: "flex",
    justifyContent: "center",
    gap: 12,
    alignItems: "center",
    marginTop: 16,
  },
  pageBtn: {
    padding: "8px 18px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#cfcfdc",
    textDecoration: "none",
  },
  pageBtnDisabled: {
    color: "#3a3a4a",
    cursor: "default",
    background: "transparent",
  },
  pageIndicator: {
    fontSize: 13,
    color: "#9090a0",
    fontFeatureSettings: '"tnum"',
  },
};
