// Admin user management page — Server Component.
//
// URL state is the source of truth:
//   ?page=1 default, ?q=<trimmed> optional. Pagination links and the
//   search input rewrite the URL, then RSC re-fetches with the new
//   params. No client cache of the user list — Server Actions
//   `revalidateTag("admin:users")` / `revalidatePath("/admin/users")`
//   keep the list fresh after create / update / delete.
//
// Search UX choice: a debounced Client Component (UserSearchInput) that
// pushes to the URL via `router.push`. Plain <form method="GET"> would
// also work but lacks the "type-then-pause" feel of the rest of the
// app (see SearchFilters in /search). Debounced router.push wins on
// UX with a ~50-LOC tradeoff.

import Link from "next/link";
import type { CSSProperties } from "react";
import { apiGetPaged, ApiError } from "@/lib/api";
import { CreateUserForm } from "../_components/CreateUserForm";
import { UserRow } from "../_components/UserRow";
import { UserSearchInput } from "../_components/UserSearchInput";
import type { AdminUser, PagedResponse } from "../_types";

// searchParams forces a dynamic render — output depends on per-request
// query. apiGetPaged uses `cache: "no-store"` for the same reason.
export const dynamic = "force-dynamic";

interface UsersPageProps {
  searchParams: Promise<{
    page?: string;
    q?: string;
  }>;
}

function buildHref(page: number, q: string): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/admin/users?${qs}` : "/admin/users";
}

async function fetchUsers(
  page: number,
  q: string,
): Promise<{ data: PagedResponse<AdminUser> | null; error: string | null }> {
  try {
    const qs = `page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const data = await apiGetPaged<AdminUser>(`/api/admin/users?${qs}`, {
      cache: "no-store",
    });
    return { data, error: null };
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn(`[AdminUsersPage] fetch failed: ${err.code} ${err.message}`);
      return { data: null, error: err.message };
    }
    console.warn("[AdminUsersPage] unexpected error:", err);
    return { data: null, error: "未知错误" };
  }
}

export default async function AdminUsersPage({ searchParams }: UsersPageProps) {
  const sp = await searchParams;
  const qRaw = sp.q ?? "";
  const q = qRaw.trim();
  const pageRaw = sp.page ?? "1";
  const pageParsed = Number(pageRaw);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1
    ? Math.floor(pageParsed)
    : 1;

  const { data, error } = await fetchUsers(page, q);

  // Total page count comes from the paged envelope. Backend uses a
  // fixed page size; mirror that here for the indicator. Without
  // `total`, fall back to "page N" alone.
  const PAGE_SIZE = 20;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasPrev = page > 1;
  const hasNext = data?.hasMore ?? false;

  return (
    <div style={styles.page}>
      <header style={styles.headerRow}>
        <h2 style={styles.heading}>用户管理</h2>
        {data && (
          <span style={styles.total}>共 {data.total.toLocaleString("zh-CN")} 名用户</span>
        )}
      </header>

      <CreateUserForm />

      <UserSearchInput initialQ={q} />

      {error ? (
        <div style={styles.error}>加载失败: {error}</div>
      ) : !data ? (
        <div style={styles.empty}>加载中...</div>
      ) : data.data.length === 0 ? (
        <div style={styles.empty}>没有匹配的用户</div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.theadRow}>
                <th style={styles.th}>用户名</th>
                <th style={styles.th}>邮箱</th>
                <th style={styles.th}>角色</th>
                <th style={styles.th}>注册时间</th>
                <th style={{ ...styles.th, textAlign: "right" }}>订阅</th>
                <th style={{ ...styles.th, textAlign: "right" }}>粉丝</th>
                <th style={styles.th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((u) => (
                <UserRow key={u._id} user={u} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.data.length > 0 && (
        <nav style={styles.pageNav} aria-label="user pagination">
          {hasPrev ? (
            <Link
              href={buildHref(page - 1, q)}
              prefetch={false}
              style={styles.pageBtn}
            >
              上一页
            </Link>
          ) : (
            <span style={{ ...styles.pageBtn, ...styles.pageBtnDisabled }} aria-disabled>
              上一页
            </span>
          )}
          <span style={styles.pageInfo}>
            第 <strong style={styles.pageNum}>{page}</strong> / {totalPages} 页
          </span>
          {hasNext ? (
            <Link
              href={buildHref(page + 1, q)}
              prefetch={false}
              style={styles.pageBtn}
            >
              下一页
            </Link>
          ) : (
            <span style={{ ...styles.pageBtn, ...styles.pageBtnDisabled }} aria-disabled>
              下一页
            </span>
          )}
        </nav>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  headerRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  heading: {
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
    color: "#f4f4f8",
  },
  total: {
    fontSize: 13,
    color: "#9090a0",
    fontFeatureSettings: '"tnum"',
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
    fontSize: 13,
  },
  theadRow: {
    background: "#111118",
    borderBottom: "1px solid #1f1f2a",
  },
  th: {
    padding: "10px 12px",
    fontSize: 11,
    fontWeight: 600,
    textAlign: "left",
    color: "#9090a0",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    borderBottom: "1px solid #1f1f2a",
    whiteSpace: "nowrap",
  },
  empty: {
    padding: "40px 24px",
    textAlign: "center",
    color: "#7c7c8c",
    fontSize: 14,
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
  },
  error: {
    padding: "16px 20px",
    color: "#ff453a",
    fontSize: 13,
    background: "rgba(255,69,58,0.06)",
    border: "1px solid rgba(255,69,58,0.4)",
    borderRadius: 10,
  },
  pageNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: "16px 0",
  },
  pageBtn: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#e7e7ef",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "none",
    display: "inline-block",
  },
  pageBtnDisabled: {
    color: "#5c5c6e",
    cursor: "not-allowed",
    background: "transparent",
    borderColor: "#1f1f2a",
  },
  pageInfo: {
    color: "#a8a8b8",
    fontSize: 13,
    fontFeatureSettings: '"tnum"',
  },
  pageNum: {
    color: "#f4f4f8",
    fontWeight: 700,
  },
};
