"use client";

// Action row that sits between Hero and the data sections on
// /anime/[id]. Hosts the five legacy interactions:
//   1. SubscriptionButton  — auth-aware, probes /api/subscriptions/:id
//   2. ShareButton         — Web Share API / clipboard fallback
//   3. MagnetButton        — opens TorrentModal (when episodes > 0)
//   4. PlayButton          — opens /player in a new tab (when episodes > 0)
//   5. TorrentModal        — rendered when state.torrentOpen is true
//
// The wrapper is a client component because TorrentModal open/close
// state needs to live somewhere outside the modal itself (clicking
// the trigger from MagnetButton flips it, ESC inside the modal also
// flips it back). Buttons themselves are also clients, but their
// state is contained to each button — they don't share with siblings.

import { useState } from "react";
import dynamic from "next/dynamic";
import SubscriptionButton from "./SubscriptionButton";
import ShareButton from "./ShareButton";
import MagnetButton from "./MagnetButton";
import PlayButton from "./PlayButton";

// Defer the modal bundle until first open — it's not on the critical
// path and the legacy modal was 466 lines (this v1 is smaller, but
// the pattern stands for when v2 swaps the empty-state for a real
// list).
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
  labels: {
    subAdd: string;
    subWatching: string;
    subRemove: string;
    subLogin: string;
    subLoginAria: string;
    share: string;
    shareCopied: string;
    shareCopyFailed: string;
    torrents: string;
    torrentsTitle: string;
    torrentsEmpty: string;
    torrentsSearchExternally: string;
    torrentsClose: string;
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
  labels,
}: DetailActionsProps) {
  const [torrentOpen, setTorrentOpen] = useState(false);
  const hasEpisodes = typeof episodes === "number" && episodes > 0;

  return (
    <>
      <div style={rowStyle}>
        <SubscriptionButton
          anilistId={anilistId}
          labels={{
            add: labels.subAdd,
            watching: labels.subWatching,
            remove: labels.subRemove,
            login: labels.subLogin,
            loginAria: labels.subLoginAria,
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
        {hasEpisodes && (
          <>
            <MagnetButton
              onOpen={() => setTorrentOpen(true)}
              label={labels.torrents}
            />
            <PlayButton ariaLabel={labels.playAria}>{labels.play}</PlayButton>
          </>
        )}
      </div>
      {torrentOpen && (
        <TorrentModal
          anime={{
            anilistId,
            titleRomaji,
            titleEnglish,
            titleChinese,
            titleNative,
            coverImageUrl,
          }}
          labels={{
            title: labels.torrentsTitle,
            empty: labels.torrentsEmpty,
            searchExternally: labels.torrentsSearchExternally,
            close: labels.torrentsClose,
          }}
          onClose={() => setTorrentOpen(false)}
        />
      )}
    </>
  );
}
