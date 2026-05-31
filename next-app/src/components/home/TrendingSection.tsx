import AnimeCard from "@/components/anime/AnimeCard";
import type { Dict, Lang } from "@/lib/i18n";
import type { TrendingItem } from "@/lib/types";

// Pure RSC: no hooks, no client interaction. Renders the legacy
// "Trending" section as a static grid of AnimeCard tiles using the
// `rank` badge on each card. Data is loaded server-side and passed
// in by the parent page (Phase 8.0 home).
interface TrendingSectionProps {
  items: TrendingItem[];
  dict: Dict;
  lang: Lang;
}

const sectionStyle = { marginTop: 40 } as const;

const labelStyle = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase" as const,
  marginBottom: 8,
} as const;

const titleStyle = {
  fontSize: "clamp(22px,3vw,32px)",
  color: "#ffffff",
} as const;

const headerStyle = { marginBottom: 16 } as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
} as const;

export default function TrendingSection({
  items,
  dict,
  lang,
}: TrendingSectionProps) {
  // Match legacy behavior: render nothing when there is no data.
  // Loading + error states live on the page (server-side data fetch).
  if (!items || items.length === 0) return null;

  return (
    <section style={sectionStyle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.trendingLabel}</p>
        <h2 style={titleStyle}>{dict.home.trendingTitle}</h2>
      </div>

      <div style={gridStyle}>
        {items.map((item, i) => (
          <AnimeCard
            key={item.anilistId}
            anime={item}
            lang={lang}
            rank={i + 1}
            watcherCount={item.watcherCount}
            prefetch={false}
          />
        ))}
      </div>
    </section>
  );
}
