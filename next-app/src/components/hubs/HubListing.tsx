// The body every hub page shares: a heading, the count, a card grid, and
// prev / next. Server-rendered, like the seasonal page it is modelled on;
// the only client boundary is the subscription-set provider around the grid.
//
// Pagination is real pages with real URLs (?page=N), not a show-more
// button, because a hub page exists to be crawled: every page of a genre
// is its own URL with its own canonical, and the prev / next links are the
// path a crawler walks to reach the long tail.

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import AnimeCard from "@/components/anime/AnimeCard";
import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import type { SeasonalAnime } from "@/lib/types";

export const HUB_PAGE_SIZE = 24;

export interface HubPagination {
  page: number;
  totalPages: number;
  total: number;
}

const containerStyle: CSSProperties = { paddingTop: 40, paddingBottom: 40 };

const headingStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,34px)",
  marginBottom: 8,
  color: "#ffffff",
  fontFamily: "var(--font-display)",
};

const countStyle: CSSProperties = {
  marginBottom: 24,
  color: "rgba(235,235,245,0.55)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  letterSpacing: "0.06em",
};

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "rgba(235,235,245,0.30)",
  fontFamily: "var(--font-display)",
};

const pagerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
  marginTop: 32,
  color: "rgba(235,235,245,0.7)",
  fontSize: 14,
};

const pagerLinkStyle: CSSProperties = {
  color: "#ffffff",
  textDecoration: "underline",
  textUnderlineOffset: 3,
};

const pagerDisabledStyle: CSSProperties = {
  color: "rgba(235,235,245,0.25)",
};

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

/** ?page=N on a bare path; page 1 is the bare path itself (its canonical). */
export function hubPageHref(basePath: string, page: number): string {
  return page <= 1 ? basePath : `${basePath}?page=${page}`;
}

export function HubListing({
  heading,
  basePath,
  items,
  pagination,
  lang,
  dict,
}: {
  heading: string;
  basePath: string;
  items: SeasonalAnime[];
  pagination: HubPagination;
  lang: Lang;
  dict: Dict;
}) {
  const { page, totalPages, total } = pagination;
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <main className="container" style={containerStyle}>
      <h1 style={headingStyle}>{heading}</h1>
      <p style={countStyle}>{fill(dict.hub.count, { n: total })}</p>

      {items.length === 0 ? (
        <div style={emptyStyle}>{dict.hub.noAnime}</div>
      ) : (
        <SubscriptionSetProvider>
          <div className="anime-grid-5col">
            {items.map((a, i) => (
              <AnimeCard key={a.anilistId} anime={a} lang={lang} prefetch={false} priority={i === 0} />
            ))}
          </div>
        </SubscriptionSetProvider>
      )}

      {totalPages > 1 && (
        <nav style={pagerStyle} aria-label="pagination">
          {hasPrev ? (
            <Link href={hubPageHref(basePath, page - 1)} style={pagerLinkStyle} rel="prev">
              {dict.hub.prev}
            </Link>
          ) : (
            <span style={pagerDisabledStyle}>{dict.hub.prev}</span>
          )}
          <span>{fill(dict.hub.pageOf, { page, total: totalPages })}</span>
          {hasNext ? (
            <Link href={hubPageHref(basePath, page + 1)} style={pagerLinkStyle} rel="next">
              {dict.hub.next}
            </Link>
          ) : (
            <span style={pagerDisabledStyle}>{dict.hub.next}</span>
          )}
        </nav>
      )}
    </main>
  );
}
