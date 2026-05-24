"use client";

// Monolithic user-management section for the single /admin page.
// Replaces the previous /admin/users route + its URL-driven
// UserSearchInput. All state (page, q) is internal — no URL sync — to
// match the legacy AdminDashboard.jsx UX.

import { useEffect, useRef, useState, useTransition } from "react";
import { CreateUserForm } from "./CreateUserForm";
import { UserRow } from "./UserRow";
import type { AdminUser, PagedResponse } from "../_types";

const DEBOUNCE_MS = 400;

interface UsersSectionProps {
  initial: PagedResponse<AdminUser>;
}

function buildApiUrl(page: number, q: string): string {
  const u = new URLSearchParams();
  u.set("page", String(page));
  if (q) u.set("q", q);
  return `/api/admin/users?${u.toString()}`;
}

export function UsersSection({ initial }: UsersSectionProps) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [data, setData] = useState<PagedResponse<AdminUser>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const isFirstRun = useRef(true);

  // Debounced commit: typing in qInput → after 400ms idle copy into q
  // which triggers the fetch effect below.
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
    const url = buildApiUrl(page, q);
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
  }, [page, q]);

  return (
    <section id="users" aria-labelledby="users-heading">
      <header style={styles.header}>
        <h2 id="users-heading" style={styles.title}>
          用户管理
        </h2>
        <span style={styles.totalHint}>
          共 {data.total.toLocaleString("zh-CN")} 个用户
        </span>
      </header>

      <CreateUserForm />

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
          placeholder="搜索用户名或邮箱"
          style={styles.searchInput}
          aria-label="搜索用户"
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

      {error && (
        <div role="alert" style={styles.errorBox}>
          {error}
        </div>
      )}

      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
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
            {data.data.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={7}>
                  没有匹配的用户
                </td>
              </tr>
            ) : (
              data.data.map((u) => <UserRow key={u._id} user={u} />)
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
  searchForm: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    marginTop: 16,
    marginBottom: 12,
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
    minWidth: 720,
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
