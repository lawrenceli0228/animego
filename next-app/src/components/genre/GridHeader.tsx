"use client";

// The grid's header: the way back to the hub, and the slice's heading with its
// count — "动作 · 正在连载 84 部". Drawn for a grid that is on its way as well,
// from what the link that opened it knew.

import Link from "@/components/ui/LocaleLink";
import type { FilterGenre } from "@/lib/contentLabels";
import { countText } from "@/lib/genre/format";
import { gridHeading } from "@/lib/genre/titles";
import type { GridView } from "@/lib/genre/views";
import { fillTemplate } from "@/lib/home/time";
import { genreHeading } from "@/lib/hubs/headings";
import { genrePath } from "@/lib/hubs/paths";
import type { Lang } from "@/lib/i18n/lang";
import { BackIcon } from "./parts";
import type { GenreCopy } from "./useGenreCopy";
import grid from "./grid.module.css";

interface GridHeaderProps {
  genre: FilterGenre;
  view: GridView;
  /** null while it is not known yet. */
  count: number | null;
  onBack: () => void;
  lang: Lang;
  copy: GenreCopy;
}

export default function GridHeader({ genre, view, count, onBack, lang, copy }: GridHeaderProps) {
  return (
    <div className={grid.wrap}>
      <Link href={genrePath(genre)} prefetch={false} className={grid.back} onNavigate={onBack} data-back>
        <BackIcon />
        {fillTemplate(copy.back, { heading: genreHeading(genre, lang) })}
      </Link>
      <div className={grid.head}>
        <h1 className={grid.h1}>{gridHeading(genre, view, lang)}</h1>
        {count === null ? null : (
          <span className={grid.count} data-count>
            {countText(copy.count, count)}
          </span>
        )}
      </div>
    </div>
  );
}
