"use client";

// A ranking page's client tree: the heading, the strip of rankings, the
// filters and the view toggle, and the ranked shows.
//
// Every other ranking — another year, a format, a genre, a season — is an
// ordinary route change through a real link in the server's HTML. While one
// is loading, the header already shows where it is going (the heading, the
// strip's block under the year pressed, the chip lit) over that view's
// skeleton, and the page that lands keeps that header as it stands
// (carriedHeader.ts) rather than fading it in again. The view is the reader's
// choice of how to draw the same hundred: it changes in place, and the
// address follows (history.replaceState, as on the seasonal page), so a
// reload or a shared link draws it the same way.
//
// The follow buttons come in as `Follow`, for the reason given in
// components/seasonal/browse/types.ts.

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import frame from "@/components/seasonal/browse/frame.module.css";
import { useLayout, useSeasonClock } from "@/components/seasonal/browse/hooks";
import type { FollowSlot } from "@/components/seasonal/browse/types";
import { topHeading } from "@/lib/hubs/headings";
import { useLang } from "@/lib/lang-client";
import { batchMemory, memoryUrl, rememberedPages } from "@/lib/seasonal/batchMemory";
import type { ViewKey } from "@/lib/seasonal/state";
import { effectiveTopView } from "@/lib/top/batch";
import type { TopPageData } from "@/lib/top/data";
import { NO_FILTERS, hasFilters, parseTopState, topCanonical, topHref, topSearch, type TopState } from "@/lib/top/query";
import { carryHeader, dropCarriedHeader, isHeaderCarried } from "./carriedHeader";
import FilterRow from "./FilterRow";
import TopResults, { TopSkeleton, type ResultsEnv } from "./TopResults";
import ViewToggle from "./ViewToggle";
import YearStrip from "./YearStrip";
import { useTopCopy } from "./useTopCopy";
import top from "./top.module.css";

export interface TopViewProps {
  data: TopPageData;
  serverNowMs: number;
  Follow: FollowSlot;
}

type Menu = "older" | "genre";

/**
 * Whether a ranking has hydrated in this document yet. Until one has, a mount
 * is the hydration of the server's HTML and must open one batch, as the server
 * did — even when a reload kept a history entry that remembers more.
 */
let hydratedOnce = false;

export default function TopView({ data, serverNowMs, Follow }: TopViewProps) {
  const { lang } = useLang();
  const { copy, browse, card } = useTopCopy();
  const { nowMs, zone } = useSeasonClock(serverNowMs);
  const layout = useLayout();
  // The router's query, not window.location: during a client navigation into
  // this page the latter still holds the page being left. A Back to this
  // page restores the view the reader had chosen from it.
  const query = useSearchParams();
  const pathname = usePathname();
  const [view, setView] = useState<ViewKey>(() => (query ? parseTopState(query, data.state.year).view : data.state.view));
  const page: TopState = useMemo(() => ({ ...data.state, view }), [data.state, view]);
  const own = memoryUrl(pathname ?? "", query?.toString() ?? "");
  const [pages, setPages] = useState(() =>
    hydratedOnce && typeof window !== "undefined" ? rememberedPages(window.history.state, own) : 1,
  );
  const [pending, setPending] = useState<TopState | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  // Whether this page's header is the one the page before it drew while this
  // one loaded: then it is drawn as it stands, no entrance.
  const [held] = useState(() => isHeaderCarried(topCanonical(data.state)));

  useEffect(() => {
    hydratedOnce = true;
    dropCarriedHeader();
  }, []);

  // The history entry remembers how many batches are open, for this address
  // only (a write can never land on another page's entry). Next's own entry
  // state rides along, so this never moves the router.
  useEffect(() => {
    if (memoryUrl(window.location.pathname, window.location.search) !== own) return;
    if (rememberedPages(window.history.state, own) === pages) return;
    window.history.replaceState({ ...window.history.state, ...batchMemory(own, pages) }, "");
  }, [own, pages]);

  // A link started loading and the reader went Back before it landed: this
  // page is staying, so the ranking it was going to goes.
  useEffect(() => {
    if (!pending) return;
    const onPop = () => {
      dropCarriedHeader();
      setPending(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [pending]);

  // One menu at a time, closed by a press anywhere outside it and by Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (menu === "older" && target?.closest?.("[data-older],[data-older-years]")) return;
      if (menu === "genre" && target?.closest?.('[data-menu="genre"]')) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setMenu(null);
      const trigger = menu === "older" ? "[data-older]" : "[data-genre-picker]";
      document.querySelector<HTMLElement>(trigger)?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const go = useCallback((next: TopState) => {
    carryHeader(topCanonical(next));
    setMenu(null);
    setPending(next);
  }, []);

  const changeView = (next: ViewKey) => {
    if (next === view) return;
    setView(next);
    setPages(1);
    const search = topSearch({ ...page, view: next });
    window.history.replaceState({ ...window.history.state }, "", `${window.location.pathname}${search}`);
  };

  const more = useCallback(() => setPages((p) => p + 1), []);
  const env = useMemo<ResultsEnv>(
    () => ({ nowMs, zone, lang, layout, copy, browse, card, Follow }),
    [nowMs, zone, lang, layout, copy, browse, card, Follow],
  );

  const shown = pending ?? page;
  const drawn = effectiveTopView(shown.view, layout);
  const cleared: TopState = { ...page, ...NO_FILTERS };

  return (
    <main
      className={frame.page}
      data-top-page={data.state.year ?? "all"}
      data-layout={layout}
      aria-busy={pending ? true : undefined}
    >
      <div className={top.head} data-held={held ? "true" : undefined} data-top-head>
        <h1 className={top.h1}>{topHeading(shown.year, lang)}</h1>
        <ViewToggle view={drawn} onView={changeView} copy={copy} />
        <YearStrip
          shown={shown}
          pageYear={data.state.year}
          strip={data.strip}
          olderOpen={menu === "older"}
          onOlder={() => setMenu(menu === "older" ? null : "older")}
          onGo={go}
          layout={layout}
          copy={copy}
        />
        <FilterRow
          shown={shown}
          page={page}
          genreOpen={menu === "genre"}
          onGenre={() => setMenu(menu === "genre" ? null : "genre")}
          onGo={go}
          layout={layout}
          lang={lang}
          copy={copy}
        />
      </div>
      {pending ? (
        <TopSkeleton view={drawn} layout={layout} />
      ) : (
        <TopResults
          key={drawn}
          items={data.items}
          view={drawn}
          pages={pages}
          onMore={more}
          isYear={data.state.year !== null}
          clearHref={hasFilters(data.state) ? topHref(cleared) : null}
          onClear={() => go(cleared)}
          env={env}
        />
      )}
    </main>
  );
}
