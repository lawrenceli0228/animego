import type { Metadata } from "next";
import { ApiError, apiGet } from "@/lib/api";
import type { TrendingItem } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Off-index, and it has to say so itself.
 *
 * This is a debug page: it prints the internal Go API address it talked to
 * and whatever that call returned or failed with. It carried
 * `index, follow` inherited from the root layout, which is to say it was
 * asking to be indexed — and robots.txt does not disallow it, so nothing
 * else was stopping a crawler.
 *
 * Removing the layout's blanket directive is what surfaced this: with the
 * inherited tag gone, "no robots tag" still means indexable, so the page
 * needs its own. `follow: false` as well because there is nothing here worth
 * following — the links are debug output.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

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
