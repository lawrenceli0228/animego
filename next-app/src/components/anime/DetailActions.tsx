"use client";

// Action row that sits between Hero and the data sections on
// /anime/[id]. Hosts the five legacy interactions:
//   1. SubscriptionButton (v2 panel: status select + ep ± + score + remove)
//   2. ShareButton         — Web Share API / clipboard fallback
//   3. MagnetButton        — opens TorrentModal (always; torrent search is
//      title-based, needs no episode count)
//   4. PlayButton          — opens /player in a new tab (always; the player
//      selects episodes itself)
//   5. TorrentModal        — rendered when state.torrentOpen is true
//
// Labels arrive flat from page.tsx and we shape them per child here so
// each child component stays decoupled from the parent dict layout.

import { useState } from "react";
import dynamic from "next/dynamic";
import SubscriptionButton from "./SubscriptionButton";
import ShareButton from "./ShareButton";
import MagnetButton from "./MagnetButton";
import PlayButton from "./PlayButton";
import type { Lang } from "@/lib/i18n";

const TorrentModal = dynamic(() => import("./TorrentModal"), {
  ssr: false,
});

interface DetailActionsProps {
  anilistId: number;
  episodes: number | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleChinese: string | null;
  titleNative: string | null;
  coverImageUrl: string | null;
  shareTitle: string;
  lang: Lang;
  labels: {
    // SubscriptionButton v2
    subAdd: string;
    subRemove: string;
    subLogin: string;
    subLoginAria: string;
    subRate: string;
    subEpUnit: string;
    subWatching: string;
    subCompleted: string;
    subPlanToWatch: string;
    subDropped: string;
    // ShareButton
    share: string;
    shareCopied: string;
    shareCopyFailed: string;
    // MagnetButton + TorrentModal
    torrents: string;
    torrentsTitle: string;
    torrentsSearchBtn: string;
    torrentsPlaceholder: string;
    torrentsGroupAll: string;
    torrentsEpAll: string;
    torrentsLoading: string;
    torrentsNoResults: string;
    torrentsClose: string;
    torrentsCopy: string;
    torrentsCopied: string;
    torrentsOpenMagnet: string;
    // PlayButton
    play: string;
    playAria: string;
  };
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap" as const,
  gap: 12,
  marginTop: 16,
} as const;

export default function DetailActions({
  anilistId,
  episodes,
  titleRomaji,
  titleEnglish,
  titleChinese,
  titleNative,
  coverImageUrl,
  shareTitle,
  lang,
  labels,
}: DetailActionsProps) {
  const [torrentOpen, setTorrentOpen] = useState(false);

  return (
    <>
      <div style={rowStyle}>
        <SubscriptionButton
          anilistId={anilistId}
          episodes={episodes}
          labels={{
            add: labels.subAdd,
            remove: labels.subRemove,
            login: labels.subLogin,
            loginAria: labels.subLoginAria,
            rate: labels.subRate,
            epUnit: labels.subEpUnit,
            watching: labels.subWatching,
            completed: labels.subCompleted,
            planToWatch: labels.subPlanToWatch,
            dropped: labels.subDropped,
          }}
        />
        <ShareButton
          anilistId={anilistId}
          shareTitle={shareTitle}
          labels={{
            share: labels.share,
            copied: labels.shareCopied,
            copyFailed: labels.shareCopyFailed,
          }}
        />
        {/* Always shown. Torrent search works off the title (no episode count
            needed) and the player selects episodes itself. Gating these on
            AniList's `episodes` total hid them for every currently-airing show,
            where AniList returns episodes=null until the run finishes. */}
        <MagnetButton
          onOpen={() => setTorrentOpen(true)}
          label={labels.torrents}
        />
        <PlayButton ariaLabel={labels.playAria}>{labels.play}</PlayButton>
      </div>
      {torrentOpen && (
        <TorrentModal
          anime={{
            anilistId,
            episodes,
            titleRomaji,
            titleEnglish,
            titleChinese,
            titleNative,
            coverImageUrl,
          }}
          labels={{
            title: labels.torrentsTitle,
            searchBtn: labels.torrentsSearchBtn,
            placeholder: labels.torrentsPlaceholder,
            groupAll: labels.torrentsGroupAll,
            epAll: labels.torrentsEpAll,
            loading: labels.torrentsLoading,
            noResults: labels.torrentsNoResults,
            close: labels.torrentsClose,
            copy: labels.torrentsCopy,
            copied: labels.torrentsCopied,
            openMagnet: labels.torrentsOpenMagnet,
          }}
          onClose={() => setTorrentOpen(false)}
          lang={lang}
        />
      )}
    </>
  );
}
