import { apiGet } from "@/lib/api";
import { EnrichmentBar } from "./_components/EnrichmentBar";
import { StatCard } from "./_components/StatCard";
import type { AdminStats } from "./_types";

// Server Component. Fetches the initial stats snapshot — the bar's
// Client Component (added in Task 5) takes over polling from here.
async function fetchInitialStats(): Promise<AdminStats | null> {
  try {
    return await apiGet<AdminStats>("/api/admin/stats", { cache: "no-store" });
  } catch {
    return null;
  }
}

export default async function AdminOverviewPage() {
  const stats = await fetchInitialStats();

  if (!stats) {
    return (
      <div style={styles.empty}>
        <p>无法加载统计数据。请检查 API 服务状态。</p>
      </div>
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
    <div style={styles.page}>
      <section aria-labelledby="overview-heading">
        <h2 id="overview-heading" style={styles.sectionTitle}>
          总览
        </h2>
        <div style={styles.grid}>
          <StatCard label="用户" value={stats.users} />
          <StatCard label="番剧缓存" value={stats.anime} hint={`V3 富化 ${v3Pct}%`} />
          <StatCard label="订阅" value={stats.subscriptions} />
          <StatCard label="关注" value={stats.follows} />
          <StatCard label="待复核" value={stats.flagged} hint="needs-review" />
          <StatCard
            label="队列任务"
            value={queueTotal}
            hint={`phase1 ${stats.queue.phase1} · phase4 ${stats.queue.phase4} · v3 ${stats.queue.v3}`}
          />
        </div>
      </section>

      <section aria-labelledby="enrichment-heading" style={styles.section}>
        <h2 id="enrichment-heading" style={styles.sectionTitle}>
          数据富化
        </h2>
        <EnrichmentBar initial={stats} />
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    gap: 28,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a8a8b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  section: {
    marginTop: 8,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16,
  },
  placeholder: {
    padding: "32px 24px",
    background: "#15151f",
    border: "1px dashed #2a2a38",
    borderRadius: 10,
    color: "#7c7c8c",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  placeholderLabel: {
    fontSize: 13,
    color: "#a8a8b8",
    fontWeight: 600,
  },
  placeholderHint: {
    fontSize: 12,
  },
  empty: {
    padding: 24,
    textAlign: "center",
    color: "#9090a0",
  },
};
