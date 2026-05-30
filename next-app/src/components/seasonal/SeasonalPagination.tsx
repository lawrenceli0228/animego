import Link from "next/link";
import type { CSSProperties } from "react";
import type { Dict, Lang } from "@/lib/i18n";

// Server-rendered pagination. Plan §UI mitigation requires that the
// seasonal grid not trigger a stampede of prefetches -- using <Link>
// with prefetch=false keeps the SEO benefit (crawlable hrefs for every
// page in the series) without paying the JS prefetch cost.
//
// Page list strategy:
//   - always show 1
//   - always show currentPage +/- 1
//   - always show last page
//   - collapse runs > 1 with a single ellipsis
// This caps the rendered list at ~7 entries even for 100+ page seasons
// while still making the first/last/neighborhood pages one click away.

interface SeasonalPaginationProps {
  season: string;
  year: number;
  page: number;
  total: number;
  pageSize?: number;
  lang: Lang;
  dict: Dict;
}

const PAGE_SIZE_DEFAULT = 20;

const wrapStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  gap: 6,
  marginTop: 32,
  flexWrap: "wrap",
};

const baseChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 36,
  height: 36,
  padding: "0 10px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  border: "1px solid #38383a",
  background: "rgba(120,120,128,0.08)",
  color: "rgba(235,235,245,0.60)",
  transition: "all 0.2s",
};

const activeChipStyle: CSSProperties = {
  ...baseChipStyle,
  background: "#0a84ff",
  borderColor: "#0a84ff",
  color: "#ffffff",
  cursor: "default",
  pointerEvents: "none",
};

const ellipsisStyle: CSSProperties = {
  ...baseChipStyle,
  background: "transparent",
  border: "none",
  pointerEvents: "none",
  color: "rgba(235,235,245,0.30)",
};

function buildPageList(current: number, last: number): Array<number | "ellipsis"> {
  if (last <= 7) {
    return Array.from({ length: last }, (_, i) => i + 1);
  }
  const candidates = new Set<number>([1, last, current - 1, current, current + 1]);
  const sorted = [...candidates]
    .filter((p) => p >= 1 && p <= last)
    .sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    out.push(p);
    const nxt = sorted[i + 1];
    if (nxt !== undefined && nxt - p > 1) {
      out.push("ellipsis");
    }
  }
  return out;
}

export default function SeasonalPagination({
  season,
  year,
  page,
  total,
  pageSize = PAGE_SIZE_DEFAULT,
  dict,
}: SeasonalPaginationProps) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage <= 1) return null;

  const href = (p: number) =>
    p === 1
      ? `/seasonal/${season}/${year}`
      : `/seasonal/${season}/${year}?page=${p}`;

  const items = buildPageList(page, lastPage);
  const prevLabel = dict.seasonPage.prevPage;
  const nextLabel = dict.seasonPage.nextPage;

  return (
    <nav style={wrapStyle} aria-label={dict.seasonPage.paginationAria}>
      {page > 1 ? (
        <Link href={href(page - 1)} prefetch={false} style={baseChipStyle} rel="prev">
          {prevLabel}
        </Link>
      ) : (
        <span style={{ ...baseChipStyle, opacity: 0.35, pointerEvents: "none" }} aria-hidden>
          {prevLabel}
        </span>
      )}

      {items.map((it, idx) =>
        it === "ellipsis" ? (
          <span key={`e-${idx}`} style={ellipsisStyle} aria-hidden>
            ...
          </span>
        ) : it === page ? (
          <span key={it} style={activeChipStyle} aria-current="page">
            {it}
          </span>
        ) : (
          <Link key={it} href={href(it)} prefetch={false} style={baseChipStyle}>
            {it}
          </Link>
        ),
      )}

      {page < lastPage ? (
        <Link href={href(page + 1)} prefetch={false} style={baseChipStyle} rel="next">
          {nextLabel}
        </Link>
      ) : (
        <span style={{ ...baseChipStyle, opacity: 0.35, pointerEvents: "none" }} aria-hidden>
          {nextLabel}
        </span>
      )}
    </nav>
  );
}
