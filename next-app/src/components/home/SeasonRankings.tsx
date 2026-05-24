import Link from "next/link";
import type { CSSProperties } from "react";
import { formatScore, pickTitle } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import type { YearlyTopItem } from "@/lib/types";

// Pure RSC. Visual parity with legacy client/src/components/home/SeasonRankings.jsx:
// compact ranking list (rank + 42×56 cover + name/meta + score), 2 cols
// desktop, 1 col mobile (<=600px). Top 3 rank digits are larger and
// orange. Hover row brightens + nudges right via CSS :hover, since RSC
// cannot wire onMouseEnter handlers.

type RankItem = YearlyTopItem & {
  genres?: string[];
};

interface SeasonRankingsProps {
  items: RankItem[];
  dict: Dict;
  lang: Lang;
}

const sectionStyle: CSSProperties = { marginTop: 48 };

const labelStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase",
  marginBottom: 8,
};

const titleStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,32px)",
  color: "#ffffff",
  margin: 0,
};

const headerStyle: CSSProperties = { marginBottom: 16 };

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 10,
};

const rowBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderRadius: 12,
  background: "#1c1c1e",
  border: "1px solid #38383a",
  textDecoration: "none",
  color: "inherit",
  transition: "background 0.2s, transform 0.25s cubic-bezier(0.4,0,0.2,1)",
};

const rankBase: CSSProperties = {
  fontFamily: "'Sora',sans-serif",
  fontWeight: 800,
  minWidth: 36,
  textAlign: "center",
  flexShrink: 0,
  lineHeight: 1,
};

function rankStyle(i: number): CSSProperties {
  const top = i < 3;
  return {
    ...rankBase,
    fontSize: top ? 28 : 22,
    color: top ? "#ff9f0a" : "rgba(235,235,245,0.30)",
  };
}

const coverStyle: CSSProperties = {
  width: 42,
  height: 56,
  borderRadius: 6,
  objectFit: "cover",
  flexShrink: 0,
  background: "#2c2c2e",
};

const infoStyle: CSSProperties = { flex: 1, minWidth: 0 };

const nameStyle: CSSProperties = {
  fontFamily: "'Sora',sans-serif",
  fontSize: 13,
  fontWeight: 600,
  color: "#ffffff",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 1,
  WebkitBoxOrient: "vertical",
  lineHeight: 1.4,
};

const metaStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(235,235,245,0.60)",
  marginTop: 2,
};

const scoreStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 14,
  fontWeight: 600,
  color: "#ff9f0a",
  flexShrink: 0,
};

const starStyle: CSSProperties = {
  color: "#ff9f0a",
  marginRight: 2,
  fontSize: 12,
};

export default function SeasonRankings({
  items,
  dict,
  lang,
}: SeasonRankingsProps) {
  if (!items || items.length === 0) return null;

  return (
    <section style={sectionStyle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.rankingsLabel}</p>
        <h2 style={titleStyle}>{dict.home.rankingsTitle}</h2>
      </div>

      <div style={gridStyle} className="season-rankings-grid">
        {items.map((anime, i) => {
          const genres = (anime.genres ?? []).slice(0, 2).join(" · ");
          const epsCount = anime.episodes ?? 0;
          const epsSuffix =
            epsCount > 0 ? ` · ${epsCount} ${dict.detail.epUnit}` : "";
          const score = anime.averageScore ?? 0;
          return (
            <Link
              key={anime.anilistId}
              href={`/anime/${anime.anilistId}`}
              style={rowBaseStyle}
              className="season-ranking-row"
              prefetch={false}
            >
              <span style={rankStyle(i)}>{i + 1}</span>
              {anime.coverImageUrl && (
                <img
                  src={anime.coverImageUrl}
                  alt={anime.titleRomaji ?? ""}
                  style={coverStyle}
                  loading="lazy"
                />
              )}
              <div style={infoStyle}>
                <div style={nameStyle}>{pickTitle(anime, lang)}</div>
                <div style={metaStyle}>
                  {genres}
                  {epsSuffix}
                </div>
              </div>
              {score > 0 && (
                <span style={scoreStyle}>
                  <span style={starStyle}>★</span>
                  {formatScore(score)}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <style>{`
        .season-ranking-row:hover {
          background: #2c2c2e !important;
          transform: translateX(4px);
        }
        @media (max-width: 600px) {
          .season-rankings-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  );
}
