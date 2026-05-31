import Link from "next/link";
import type { CSSProperties } from "react";
import type { Dict, Lang } from "@/lib/i18n";

// Season nav stays a pure server component: Next <Link> handles the
// route change with no client JS needed. The legacy SeasonSelector used
// useNavigate + a controlled <select>, but for SEO and zero-JS
// fallback the server-rendered links are stricter -- crawlers see real
// hrefs for every (season, year) combo we want indexed.

type SeasonKey = "spring" | "summer" | "fall" | "winter";

const SEASON_ORDER: SeasonKey[] = ["winter", "spring", "summer", "fall"];

// Range of years offered in the year dropdown. Matches the legacy
// SeasonSelector range (2000 -> currentYear+1) so SEO link surface stays
// stable across the migration cutover.
const YEAR_MIN = 2000;

interface SeasonNavProps {
  season: SeasonKey;
  year: number;
  dict: Dict;
  lang: Lang;
}

// Compute previous / next (season, year) in the seasonal cycle. Wraps
// across year boundaries: winter <year> -> fall <year-1> on the prev
// side; fall <year> -> winter <year+1> on the next side.
function adjacent(season: SeasonKey, year: number, dir: -1 | 1): { season: SeasonKey; year: number } {
  const idx = SEASON_ORDER.indexOf(season);
  const nextIdx = idx + dir;
  if (nextIdx < 0) return { season: SEASON_ORDER[SEASON_ORDER.length - 1], year: year - 1 };
  if (nextIdx >= SEASON_ORDER.length) return { season: SEASON_ORDER[0], year: year + 1 };
  return { season: SEASON_ORDER[nextIdx], year };
}

const wrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  flexWrap: "wrap",
  marginBottom: 24,
};

const navBtnStyle: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #38383a",
  background: "rgba(120,120,128,0.08)",
  color: "rgba(235,235,245,0.60)",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  transition: "all 0.2s",
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  background: "#1c1c1e",
  borderRadius: 10,
  padding: 4,
  border: "1px solid #38383a",
};

const tabStyle = (active: boolean): CSSProperties => ({
  padding: "6px 16px",
  borderRadius: 7,
  fontSize: 14,
  fontWeight: active ? 600 : 500,
  textDecoration: "none",
  transition: "all 0.2s",
  background: active ? "#0a84ff" : "transparent",
  color: active ? "#fff" : "rgba(235,235,245,0.60)",
});

const yearListStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  flexWrap: "wrap",
  alignItems: "center",
};

const yearChipStyle = (active: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: active ? 700 : 500,
  textDecoration: "none",
  background: active ? "rgba(10,132,255,0.15)" : "rgba(120,120,128,0.08)",
  color: active ? "#0a84ff" : "rgba(235,235,245,0.45)",
  border: active ? "1px solid rgba(10,132,255,0.30)" : "1px solid transparent",
  transition: "all 0.2s",
});

export default function SeasonNav({ season, year, dict }: SeasonNavProps) {
  const prev = adjacent(season, year, -1);
  const next = adjacent(season, year, 1);

  // The year strip shows current year +/- 4 so the dominant nav surface
  // is the live decade window. Anything older is still reachable via
  // back/forward arrows (and direct URL), but SEO crawl budget should
  // bias toward recency.
  const currentYear = new Date().getFullYear();
  const windowStart = Math.max(YEAR_MIN, Math.min(year, currentYear) - 4);
  const windowEnd = Math.min(currentYear + 1, windowStart + 9);
  const years: number[] = [];
  for (let y = windowEnd; y >= windowStart; y -= 1) years.push(y);

  const yearWord = dict.season.year;

  return (
    <nav style={wrapStyle} aria-label={dict.seasonPage.navAria}>
      <Link
        href={`/seasonal/${prev.season}/${prev.year}`}
        prefetch={false}
        style={navBtnStyle}
        aria-label={dict.seasonPage.prevSeasonAria}
      >
        {dict.seasonPage.prevSeason}
      </Link>

      <div style={tabsStyle}>
        {SEASON_ORDER.map((s) => {
          const isActive = s === season;
          const label = dict.season[s.toUpperCase() as "WINTER" | "SPRING" | "SUMMER" | "FALL"];
          return (
            <Link
              key={s}
              href={`/seasonal/${s}/${year}`}
              prefetch={false}
              style={tabStyle(isActive)}
              aria-current={isActive ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <Link
        href={`/seasonal/${next.season}/${next.year}`}
        prefetch={false}
        style={navBtnStyle}
        aria-label={dict.seasonPage.nextSeasonAria}
      >
        {dict.seasonPage.nextSeason}
      </Link>

      <div style={yearListStyle} aria-label={dict.seasonPage.switchYear}>
        {years.map((y) => (
          <Link
            key={y}
            href={`/seasonal/${season}/${y}`}
            prefetch={false}
            style={yearChipStyle(y === year)}
          >
            {y}{yearWord}
          </Link>
        ))}
      </div>
    </nav>
  );
}
