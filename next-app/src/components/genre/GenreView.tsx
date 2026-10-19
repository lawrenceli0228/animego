"use client";

// The genre page's client tree: the hub view or the grid view, as the server
// rendered them, on the seasonal page's frame and with its cards.
//
// Moving between the two views, and between genres, is an ordinary route
// change (every way there is a real link in the server's HTML). While one is
// loading, the page already shows where it is going, as the approved
// artboards do: the header of the view on its way (the genre pressed in the
// strip, with the block sliding under it; the grid's heading and count; the
// hub's heading on the way back) over that view's 2s shimmer. The page clock
// is the seasonal page's: the server's time through hydration, then the
// reader's.
//
// The follow buttons come in as `Follow`, for the reason given in
// components/seasonal/browse/types.ts.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import frame from "@/components/seasonal/browse/frame.module.css";
import { useLayout, useSeasonClock } from "@/components/seasonal/browse/hooks";
import type { FollowSlot } from "@/components/seasonal/browse/types";
import type { FilterGenre } from "@/lib/contentLabels";
import { genreAiringText } from "@/lib/genre/display";
import { heroCountText } from "@/lib/genre/format";
import type { GenrePageData } from "@/lib/genre/grid";
import type { StripEntry } from "@/lib/genre/strip";
import type { GridView } from "@/lib/genre/views";
import { genreSlug } from "@/lib/hubs/paths";
import { useLang } from "@/lib/lang-client";
import type { AiringVariant } from "@/lib/seasonal/display";
import type { SeasonalItem } from "@/lib/seasonal/model";
import GridHeader from "./GridHeader";
import GridResults from "./GridResults";
import HubBody from "./HubBody";
import HubHero from "./HubHero";
import { GridSkeleton, HubSkeleton } from "./Skeletons";
import type { CardEnv, PendingTarget } from "./types";
import { useGenreCopy } from "./useGenreCopy";

export interface GenreViewProps {
  genre: FilterGenre;
  data: GenrePageData;
  strip: readonly StripEntry[];
  serverNowMs: number;
  Follow: FollowSlot;
}

export default function GenreView({ genre, data, strip, serverNowMs, Follow }: GenreViewProps) {
  const { lang } = useLang();
  const { copy, browse, card } = useGenreCopy();
  const { nowMs, zone } = useSeasonClock(serverNowMs);
  const layout = useLayout();
  const [pending, setPending] = useState<PendingTarget | null>(null);

  // A link started loading and the reader went Back before it landed: this
  // page is staying, so the view it was going to goes.
  useEffect(() => {
    if (!pending) return;
    const onPop = () => setPending(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [pending]);

  const airing = useCallback(
    (item: SeasonalItem, now: number, variant: AiringVariant) => genreAiringText(item, now, card, lang, variant),
    [card, lang],
  );
  const env = useMemo<CardEnv>(
    () => ({ nowMs, zone, lang, copy: browse, Follow, layout, airing }),
    [nowMs, zone, lang, browse, Follow, layout, airing],
  );

  const toHub = (next: FilterGenre) => setPending({ kind: "hub", genre: next });
  const toGrid = (view: GridView, count: number | null) => setPending({ kind: "grid", view, count });

  let header: ReactNode;
  let body: ReactNode;
  if (pending?.kind === "grid") {
    header = <GridHeader genre={genre} view={pending.view} count={pending.count} onBack={() => toHub(genre)} lang={lang} copy={copy} />;
    body = <GridSkeleton />;
  } else if (pending?.kind === "hub" || data.kind === "hub") {
    const countLine = !pending && data.kind === "hub" ? heroCountText(copy, data.total, data.airing) : "";
    header = (
      <HubHero
        genre={genre}
        shown={pending?.kind === "hub" ? pending.genre : genre}
        countLine={countLine}
        strip={strip}
        onPick={toHub}
        lang={lang}
        copy={copy}
      />
    );
    body = pending || data.kind !== "hub" ? <HubSkeleton /> : (
      <HubBody genre={genre} data={data} onGrid={toGrid} env={env} copy={copy} card={card} />
    );
  } else {
    header = <GridHeader genre={genre} view={data.view} count={data.total} onBack={() => toHub(genre)} lang={lang} copy={copy} />;
    body = <GridResults genre={genre} data={data} env={env} copy={copy} />;
  }

  return (
    <main
      className={frame.page}
      data-genre-page={genreSlug(genre)}
      data-view={data.kind}
      data-layout={layout}
      aria-busy={pending ? true : undefined}
    >
      {header}
      {body}
    </main>
  );
}
