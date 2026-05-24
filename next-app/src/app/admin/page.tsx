import { apiGet, apiGetPaged } from "@/lib/api";
import { EnrichmentBar } from "./_components/EnrichmentBar";
import { EnrichmentSection } from "./_components/EnrichmentSection";
import { StatCard } from "./_components/StatCard";
import { UsersSection } from "./_components/UsersSection";
import type {
  AdminStats,
  AdminUser,
  EnrichmentRow as EnrichmentRowData,
  PagedResponse,
} from "./_types";

// Monolithic single-page admin (one /admin route, three sections).
//
// Matches legacy AdminDashboard.jsx UX: stats overview + enrichment
// management + user management all on one scrollable page. The nav
// links in layout.tsx are anchor scrolls (#overview / #enrichment /
// #users) — no extra routes.
//
// The server fetches all three datasets in parallel; client sections
// take over for filter / search / pagination after hydration. If any
// fetch fails, that section gets `null` and renders an inline error
// rather than crashing the whole page.

const EMPTY_PAGE: PagedResponse<unknown> = {
  data: [],
  hasMore: false,
  total: 0,
  page: 1,
};

async function safeGet<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export default async function AdminPage() {
  const [stats, enrichment, users] = await Promise.all([
    safeGet<AdminStats | null>(
      apiGet<AdminStats>("/api/admin/stats", { cache: "no-store" }),
      null,
    ),
    safeGet<PagedResponse<EnrichmentRowData>>(
      apiGetPaged<EnrichmentRowData>(
        "/api/admin/enrichment?page=1&sort=cachedAt&order=desc",
        { cache: "no-store" },
      ),
      EMPTY_PAGE as PagedResponse<EnrichmentRowData>,
    ),
    safeGet<PagedResponse<AdminUser>>(
      apiGetPaged<AdminUser>("/api/admin/users?page=1", { cache: "no-store" }),
      EMPTY_PAGE as PagedResponse<AdminUser>,
    ),
  ]);

  return (
    <div style={styles.page}>
      <Overview stats={stats} />
      <hr style={styles.divider} />
      <EnrichmentSection initial={enrichment} />
      <hr style={styles.divider} />
      <UsersSection initial={users} />
    </div>
  );
}

function Overview({ stats }: { stats: AdminStats | null }) {
  if (!stats) {
    return (
      <section
        id="overview"
        aria-labelledby="overview-heading"
        style={styles.overview}
      >
        <h2 id="overview-heading" style={styles.sectionTitle}>
          总览
        </h2>
        <div style={styles.errorBox}>
          无法加载统计数据。请检查 API 服务状态。
        </div>
      </section>
    );
  }

  const enrichedTotal =
    stats.enrichment.v0 +
    stats.enrichment.v1 +
    stats.enrichment.v2 +
    stats.enrichment.v3;
  const v3Pct =
    enrichedTotal > 0
      ? Math.round((stats.enrichment.v3 / enrichedTotal) * 100)
      : 0;
  const queueTotal =
    stats.queue.phase1 + stats.queue.phase4 + stats.queue.v3;

  return (
    <section
      id="overview"
      aria-labelledby="overview-heading"
      style={styles.overview}
    >
      <h2 id="overview-heading" style={styles.sectionTitle}>
        总览
      </h2>
      <div style={styles.grid}>
        <StatCard label="用户" value={stats.users} />
        <StatCard
          label="番剧缓存"
          value={stats.anime}
          hint={`V3 富化 ${v3Pct}%`}
        />
        <StatCard label="订阅" value={stats.subscriptions} />
        <StatCard label="关注" value={stats.follows} />
        <StatCard label="待复核" value={stats.flagged} hint="needs-review" />
        <StatCard
          label="队列任务"
          value={queueTotal}
          hint={`phase1 ${stats.queue.phase1} · phase4 ${stats.queue.phase4} · v3 ${stats.queue.v3}`}
        />
      </div>
      <div style={styles.barWrap}>
        <h3 style={styles.subTitle}>数据富化</h3>
        <EnrichmentBar initial={stats} />
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    gap: 28,
  },
  overview: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a8a8b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    margin: 0,
  },
  subTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#a8a8b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    margin: "0 0 12px 0",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16,
  },
  barWrap: {
    marginTop: 4,
  },
  divider: {
    border: 0,
    borderTop: "1px solid #1f1f2a",
    margin: "8px 0",
  },
  errorBox: {
    background: "#3a0d0d",
    border: "1px solid #663030",
    color: "#ffb4b4",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
  },
};
