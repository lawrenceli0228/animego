// Everything the /anime/[id] tabs share: the per-anime colour scope, the
// hero with its action row, the tab bar, and the column the tab's own
// content goes in.
//
// A component every page renders rather than a layout.tsx, on purpose. The
// tab bar needs to know which tab is active, and a layout is not told: it
// would have to read the pathname on the client and could not render the
// active state into the cached HTML. Each tab is a page with its own ISR
// entry and its own notFound(), exactly like the overview always was, and
// this is the part of them that is the same.
//
// Server component. It reads no cookie or header (see the note at the top of
// the overview page): these routes are served from the ISR cache and a
// Cloudflare edge cache, so everything per-user is a client leaf.

import type { ReactNode } from "react";
import DetailActions from "@/components/anime/DetailActions";
import HeroAccent from "@/components/anime/HeroAccent";
import type { TrailerPreviewLabels } from "@/components/anime/TrailerPreview";
import type { DetailTabCounts, DetailTabKey } from "@/lib/detail/tabs";
import { pickTitle } from "@/lib/formatters";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import type { AnimeDetail } from "@/lib/types";
import { asYouTubeTrailer } from "@/lib/youtubeTrailer";
import DetailHero from "./DetailHero";
import DetailTabs from "./DetailTabs";
import s from "./DetailShell.module.css";

/** The trailer's labels, for the hero's phone button and the overview's card. */
export function detailTrailerLabels(dict: Dict): TrailerPreviewLabels {
  return {
    official: dict.detail.officialTrailer,
    watch: dict.detail.watchTrailer,
    watchAria: dict.detail.watchTrailerAria,
    close: dict.detail.closeTrailer,
    openYouTube: dict.detail.openTrailerOnYouTube,
  };
}

export default function DetailShell({
  detail,
  lang,
  dict,
  active,
  counts,
  children,
}: {
  detail: AnimeDetail;
  lang: Lang;
  dict: Dict;
  active: DetailTabKey;
  counts: DetailTabCounts;
  children: ReactNode;
}) {
  const trailer = asYouTubeTrailer(detail.trailer);
  return (
    <main className={s.page} data-tab={active}>
      {/* Wraps the WHOLE page, not just the hero.
       *
       * HeroAccent carries `--poster-hue` and the `.poster-scope` class that
       * builds `--poster-tone*` from it, and a custom property's var() is
       * substituted on the element that DECLARES it — so those tokens only
       * hold the anime's hue inside this element. Everything below the hero
       * reads them (the sections, EpisodesGrid, the tab bar and both list
       * tabs), so closing the wrapper after the hero would leave all of it on
       * the :root fallback: one violet for every anime, with nothing failing
       * and the stylesheet still reading correctly. See globals.css
       * `.poster-scope`.
       *
       * HeroAccent takes props only and reads no cookie or header. */}
      <HeroAccent
        anilistId={detail.anilistId}
        coverImageUrl={detail.coverImageUrl}
        posterAccent={detail.posterAccent ?? null}
        posterAccentRgb={detail.posterAccentRgb ?? null}
      >
        <DetailHero
          detail={detail}
          lang={lang}
          dict={dict}
          compact={active !== "overview"}
          actions={
            <DetailActions
              anilistId={detail.anilistId}
              episodes={detail.episodes}
              titleRomaji={detail.titleRomaji}
              titleEnglish={detail.titleEnglish}
              titleChinese={detail.titleChinese}
              titleNative={detail.titleNative}
              coverImageUrl={detail.coverImageUrl}
              shareTitle={pickTitle(detail, lang)}
              lang={lang}
              trailerId={trailer?.id ?? null}
              trailerLabels={detailTrailerLabels(dict)}
              labels={{
                subAdd: dict.sub.addToList,
                subRemove: dict.sub.remove,
                subLogin: dict.sub.loginToWatch,
                subLoginAria: dict.sub.loginToWatch,
                subRate: dict.sub.rate,
                subWatching: dict.sub.watching,
                subCompleted: dict.sub.completed,
                subPlanToWatch: dict.sub.planToWatch,
                subDropped: dict.sub.dropped,
                share: dict.social.share,
                shareCopied: dict.detail.linkCopied,
                shareCopyFailed: dict.detail.linkCopyFailed,
                torrents: dict.torrent.download,
                torrentsTitle: dict.torrent.title,
                torrentsSearchBtn: dict.torrent.searchBtn,
                torrentsPlaceholder: dict.torrent.placeholder,
                torrentsGroupAll: dict.torrent.groupAll,
                torrentsEpAll: dict.torrent.epAll,
                torrentsLoading: dict.torrent.loading,
                torrentsNoResults: dict.torrent.noResults,
                torrentsClose: dict.torrent.close,
                torrentsCopy: dict.torrent.copy,
                torrentsCopied: dict.torrent.copied,
                torrentsOpenMagnet: dict.torrent.openMagnet,
                torrentsSeeders: dict.torrent.seeders,
                play: dict.detail.openPlayer,
                playAria: dict.detail.openPlayerAria,
              }}
            />
          }
        />
        <DetailTabs anilistId={detail.anilistId} active={active} counts={counts} dict={dict} />
        <div className={`container ${s.body}`}>{children}</div>
      </HeroAccent>
    </main>
  );
}
