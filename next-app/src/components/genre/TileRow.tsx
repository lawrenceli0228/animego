"use client";

// One of the hub's three tile rows — 年代分布, 常一起出现, 代表制作公司 — and
// its tiles: each a link (to the grid view of that slice, or to the studio's
// own page) on a ground in its first cover's hue, with three covers fanned at
// the top right and the name and count at the bottom left. The link's name
// is that text, with a few words more for a screen reader where the tile alone
// does not say whose titles it counts — so a voice command for the visible
// words finds it (WCAG 2.5.3).

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { genreLabel, type FilterGenre } from "@/lib/contentLabels";
import { countText } from "@/lib/genre/format";
import type { GenreTile } from "@/lib/genre/hub";
import { decadeGhost, decadeTileLabel } from "@/lib/genre/titles";
import { gridHref, type GridView } from "@/lib/genre/views";
import { oklchCss } from "@/lib/home/tone";
import { fillTemplate } from "@/lib/home/time";
import { studioPath } from "@/lib/hubs/paths";
import type { Lang } from "@/lib/i18n/lang";
import { Section, SectionHead } from "./parts";
import type { OpenGrid } from "./types";
import type { GenreCopy } from "./useGenreCopy";
import tiles from "./tiles.module.css";

/** A tile with no cover keeps a quiet ground of its own. */
const NEUTRAL_GROUND = "rgba(255, 255, 255, 0.045)";
const TILE_STEP_MS = 40;

interface TileRowProps {
  genre: FilterGenre;
  title: string;
  hook: "decades" | "related" | "studios";
  items: readonly GenreTile[];
  /** The row's entrance. */
  delayMs: number;
  /** When its first tile comes in; each next one TILE_STEP_MS later. */
  tileBaseMs: number;
  lang: Lang;
  copy: GenreCopy;
  /** A tile that opens a grid view of this genre was followed. */
  onGrid: OpenGrid;
}

interface TileText {
  href: string;
  label: string;
  /** Read after the name and count; null where they say it all. */
  hint: string | null;
  ghost: string | null;
  /** The view of this page it opens (whose header and skeleton show while it loads); null for a studio's own page. */
  view: GridView | null;
}

function textOf(tile: GenreTile, genre: FilterGenre, lang: Lang, copy: GenreCopy): TileText {
  if (tile.kind === "decade") {
    return {
      href: gridHref(genre, { kind: "decade", decade: tile.decade }),
      label: decadeTileLabel(tile.decade, lang),
      hint: null,
      ghost: decadeGhost(tile.decade),
      view: { kind: "decade", decade: tile.decade },
    };
  }
  if (tile.kind === "with") {
    const label = genreLabel(tile.genre, lang);
    return {
      href: gridHref(genre, { kind: "with", with: tile.genre }),
      label,
      hint: fillTemplate(copy.relatedHint, { genre: genreLabel(genre, lang), other: label }),
      ghost: null,
      view: { kind: "with", with: tile.genre },
    };
  }
  return {
    href: studioPath(tile.studio),
    label: tile.studio,
    hint: fillTemplate(copy.studioHint, { genre: genreLabel(genre, lang) }),
    ghost: null,
    view: null,
  };
}

export default function TileRow({ genre, title, hook, items, delayMs, tileBaseMs, lang, copy, onGrid }: TileRowProps) {
  const id = `genre-tiles-${hook}`;
  return (
    <Section delayMs={delayMs} labelledBy={id} hook={hook}>
      <SectionHead id={id} title={title} />
      {/* role="list": Safari drops a list's semantics with its markers. */}
      <ul className={tiles.tiles} role="list" data-tiles={hook}>
        {items.map((tile, i) => {
          const text = textOf(tile, genre, lang, copy);
          const { view } = text;
          const hasCover = tile.covers.length > 0;
          return (
            <li
              key={text.href}
              className={tiles.item}
              style={{ animationDelay: `${tileBaseMs + i * TILE_STEP_MS}ms` }}
            >
              <Link
                href={text.href}
                prefetch={false}
                className={tiles.tile}
                style={{ background: hasCover ? oklchCss(21, 0.045, tile.hue) : NEUTRAL_GROUND }}
                onNavigate={view ? () => onGrid(view, tile.count) : undefined}
                data-tile={tile.kind}
              >
                <span className={tiles.fan} aria-hidden="true">
                  {tile.covers.map((cover, j) => (
                    <span
                      key={cover.id}
                      className={tiles.tc}
                      data-fan={j + 1}
                      style={{ background: oklchCss(24, 0.045, cover.hue) }}
                    >
                      <FadeImage src={cover.src} alt="" width={42} height={60} className={tiles.tcImg} />
                    </span>
                  ))}
                </span>
                {!hasCover && text.ghost ? (
                  <span className={tiles.ghost} aria-hidden="true">
                    {text.ghost}
                  </span>
                ) : null}
                <span className={tiles.text}>
                  <b className={tiles.name}>{text.label}</b>
                  <em className={tiles.num}>{countText(copy.count, tile.count)}</em>
                </span>
                {text.hint ? <span className={tiles.srOnly}>{text.hint}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
