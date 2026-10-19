"use client";

// One of the hub's rails: a section head with the slice's count and "see
// all", and six of the seasonal page's cover cards in a row (a track that
// scrolls, below 1024px).

import CoverCard from "@/components/seasonal/browse/CoverCard";
import cards from "@/components/seasonal/browse/cards.module.css";
import type { FilterGenre } from "@/lib/contentLabels";
import { countText } from "@/lib/genre/format";
import type { GenreRail } from "@/lib/genre/hub";
import { listLabel } from "@/lib/genre/titles";
import { gridHref } from "@/lib/genre/views";
import { fillTemplate } from "@/lib/home/time";
import { DEFAULT_STATE } from "@/lib/seasonal/state";
import { Section, SectionHead } from "./parts";
import type { GenreCopy } from "./useGenreCopy";
import type { CardEnv } from "./types";

/** Each rail starts this much after the one above it. */
export const RAIL_STEP_MS = 90;
/** And each of its cards this much after the one before. */
const CARD_STEP_MS = 34;

interface RailProps {
  genre: FilterGenre;
  rail: GenreRail;
  /** Its place among the rails: the entrance is staggered by it. */
  index: number;
  env: CardEnv;
  copy: GenreCopy;
  onSeeAll: () => void;
}

export default function Rail({ genre, rail, index, env, copy, onSeeAll }: RailProps) {
  const title = listLabel(rail.key, env.lang);
  const base = index * RAIL_STEP_MS;
  return (
    <Section delayMs={base} label={title} hook={`rail-${rail.key}`}>
      <SectionHead
        title={title}
        // 人气最高 is the whole genre: its count would only repeat the heading's.
        count={rail.key === "popular" ? undefined : countText(copy.count, rail.count)}
        all={{
          href: gridHref(genre, { kind: "list", list: rail.key }),
          label: copy.seeAll,
          ariaLabel: fillTemplate(copy.seeAllAria, { list: title }),
          onNavigate: onSeeAll,
          hook: rail.key,
        }}
      />
      <div className={cards.row6} data-rail={rail.key}>
        {rail.items.map((item, i) => (
          <CoverCard
            key={item.id}
            item={item}
            hidden={false}
            delayMs={base + i * CARD_STEP_MS}
            nowMs={env.nowMs}
            zone={env.zone}
            state={DEFAULT_STATE}
            mode="weekday"
            lang={env.lang}
            copy={env.copy}
            Follow={env.Follow}
            priority={index === 0 && i === 0}
            airing={env.airing}
          />
        ))}
      </div>
    </Section>
  );
}
