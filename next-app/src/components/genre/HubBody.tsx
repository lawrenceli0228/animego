"use client";

// The hub's body, under its heading and strip: the rails (正在连载 · 人气最高 ·
// 近年新作 · 经典老番) beside 评分前 10, then the three tile rows.

import type { FilterGenre } from "@/lib/contentLabels";
import type { GenreCardCopy } from "@/lib/genre/display";
import type { GenreHubData } from "@/lib/genre/hub";
import Rail, { RAIL_STEP_MS } from "./Rail";
import TileRow from "./TileRow";
import TopTen from "./TopTen";
import type { CardEnv, OpenGrid } from "./types";
import type { GenreCopy } from "./useGenreCopy";
import hub from "./hub.module.css";

/** The tile rows come in after the rails: their sections, and their first tiles. */
const TILES_AFTER_RAILS_MS = { decades: 60, related: 140, studios: 220 } as const;
const TILE_BASE_AFTER_RAILS_MS = { decades: 200, related: 320, studios: 440 } as const;

interface HubBodyProps {
  genre: FilterGenre;
  data: GenreHubData;
  onGrid: OpenGrid;
  env: CardEnv;
  copy: GenreCopy;
  card: GenreCardCopy;
}

export default function HubBody({ genre, data, onGrid, env, copy, card }: HubBodyProps) {
  const { lang } = env;
  const railsEnd = data.rails.length * RAIL_STEP_MS;
  const rows = [
    { hook: "decades", title: copy.decades, items: data.decades },
    { hook: "related", title: copy.related, items: data.related },
    { hook: "studios", title: copy.studios, items: data.studios },
  ] as const;

  return (
    <>
      <div className={hub.body}>
        <div className={hub.rows}>
          {data.rails.map((rail, i) => (
            <Rail
              key={rail.key}
              genre={genre}
              rail={rail}
              index={i}
              env={env}
              copy={copy}
              onSeeAll={() => onGrid({ kind: "list", list: rail.key }, rail.count)}
            />
          ))}
        </div>
        {data.top.length > 0 ? (
          // A plain column: the section inside is the landmark, named by its heading.
          <div className={hub.side}>
            <TopTen
              genre={genre}
              items={data.top}
              lang={lang}
              copy={copy}
              card={card}
              onSeeAll={() => onGrid({ kind: "list", list: "top" }, data.topCount || null)}
            />
          </div>
        ) : null}
      </div>

      {rows.map((row) =>
        row.items.length > 0 ? (
          <TileRow
            key={row.hook}
            genre={genre}
            title={row.title}
            hook={row.hook}
            items={row.items}
            delayMs={railsEnd + TILES_AFTER_RAILS_MS[row.hook]}
            tileBaseMs={railsEnd + TILE_BASE_AFTER_RAILS_MS[row.hook]}
            lang={lang}
            copy={copy}
            onGrid={onGrid}
          />
        ) : null,
      )}
    </>
  );
}
