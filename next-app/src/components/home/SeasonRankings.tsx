import Link from "next/link";
import AnimeCard from "@/components/anime/AnimeCard";
import type { Dict, Lang } from "@/lib/i18n";
import type { SeasonalAnime } from "@/lib/types";

// Pure RSC: no hooks, no client interaction. Renders the current
// season's anime as a static grid of AnimeCard tiles (no rank badge,
// since this is a season listing, not a ranking). Includes a
// "View all" link to the dedicated seasonal route.
interface SeasonRankingsProps {
  items: SeasonalAnime[];
  dict: Dict;
  lang: Lang;
  season: string;
  year: number;
}

const sectionStyle = { marginTop: 48 } as const;

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
  margin: 0,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 20,
  flexWrap: "wrap" as const,
} as const;

const headerLeftStyle = { minWidth: 0 } as const;

const viewAllStyle = {
  color: "#0a84ff",
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap" as const,
} as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
} as const;

export default function SeasonRankings({
  items,
  dict,
  lang,
  season,
  year,
}: SeasonRankingsProps) {
  // Match legacy: render nothing when there is no data.
  if (!items || items.length === 0) return null;

  const viewAllHref = `/seasonal/${season.toLowerCase()}/${year}`;
  const viewAllLabel = lang === "zh" ? "查看全部 ->" : "View all ->";

  return (
    <section style={sectionStyle}>
      <div style={headerStyle}>
        <div style={headerLeftStyle}>
          <p style={labelStyle}>{dict.home.rankingsLabel}</p>
          <h2 style={titleStyle}>{dict.home.rankingsTitle}</h2>
        </div>
        <Link href={viewAllHref} style={viewAllStyle} prefetch={false}>
          {viewAllLabel}
        </Link>
      </div>

      <div style={gridStyle}>
        {items.map((item) => (
          <AnimeCard
            key={item.anilistId}
            anime={item}
            lang={lang}
            prefetch={false}
          />
        ))}
      </div>
    </section>
  );
}
