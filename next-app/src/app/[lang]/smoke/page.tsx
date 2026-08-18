import { ApiError, apiGet } from "@/lib/api";
import type { TrendingItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SmokePage() {
  let trending: TrendingItem[] = [];
  let err: string | null = null;

  try {
    trending = await apiGet<TrendingItem[]>(
      "/api/anime/trending?limit=5",
    );
  } catch (e) {
    err =
      e instanceof ApiError
        ? `${e.code} (${e.status}): ${e.message}`
        : e instanceof Error
          ? e.message
          : "unknown error";
  }

  return (
    <main
      style={{
        padding: "2rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <h1>P4.0 RSC smoke</h1>
      <p style={{ color: "#666" }}>
        <code>apiGet&lt;TrendingItem[]&gt;(&apos;/api/anime/trending&apos;)</code>{" "}
        served from{" "}
        <code>
          {process.env.GO_API_INTERNAL_URL || "http://localhost:8080"}
        </code>
      </p>

      {err && (
        <div
          style={{
            color: "#b00",
            background: "#fee",
            padding: "1rem",
            borderRadius: 4,
            marginBottom: "1rem",
          }}
        >
          <strong>ERROR:</strong> {err}
        </div>
      )}

      <ol>
        {trending.map((a) => (
          <li key={a.anilistId} style={{ marginBottom: "0.5rem" }}>
            <strong>{a.titleChinese || a.titleRomaji || `#${a.anilistId}`}</strong>
            <span style={{ color: "#666", marginLeft: "0.5rem" }}>
              rank {a.rank} · {a.watcherCount} watchers
            </span>
          </li>
        ))}
      </ol>

      {!err && trending.length > 0 && (
        <p style={{ color: "#080", marginTop: "2rem" }}>
          ✓ If the list above is server-rendered (view-source shows the titles),
          Phase 4 RSC fetch through getApiBase() is wired correctly.
        </p>
      )}
    </main>
  );
}
