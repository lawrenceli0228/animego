"use client";

// Action row that sits between Hero and the data sections on
// /anime/[id]. Hosts the five legacy interactions:
//   1. SubscriptionButton (status select + score + remove). The episode
//      counter that used to live here moved into the episode grid itself,
//      which now records watched episodes one by one — see EpisodesGrid.tsx.
//   2. ShareButton         — Web Share API / clipboard fallback
//   3. MagnetButton        — opens the magnet panel (always; torrent search
//      is title-based, needs no episode count)
//   4. PlayButton          — explains the local-file flow, then hands off to
//      the magnet panel or /library
//   5. MagnetPanel         — rendered while open, in the page's hue
//
// Labels arrive flat from page.tsx and we shape them per child here so
// each child component stays decoupled from the parent dict layout.

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import SubscriptionButton from "./SubscriptionButton";
import ShareButton from "./ShareButton";
import MagnetButton from "./MagnetButton";
import PlayButton from "./PlayButton";
import TrailerPreview, { type TrailerPreviewLabels } from "./TrailerPreview";
import { parseHue } from "@/lib/magnet/titles";
import styles from "./DetailActions.module.css";

const MagnetPanel = dynamic(() => import("./magnet/MagnetPanel"), {
  ssr: false,
});

interface DetailActionsProps {
  anilistId: number;
  /** AniList's count. The magnet panel's, and nothing inferred. */
  episodes: number | null;
  /**
   * The total the episode grid draws (`gridTotal`), for the subscription
   * control's "watched N / total". Separate from `episodes` so an inferred
   * count reaches that readout and nothing else.
   */
  progressTotal: number | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleChinese: string | null;
  titleNative: string | null;
  coverImageUrl: string | null;
  shareTitle: string;
  trailerId: string | null;
  trailerLabels: TrailerPreviewLabels;
  labels: {
    // SubscriptionButton v2
    subAdd: string;
    subRemove: string;
    subLogin: string;
    subLoginAria: string;
    subRate: string;
    subWatching: string;
    subCompleted: string;
    subPlanToWatch: string;
    subDropped: string;
    // ShareButton
    share: string;
    shareCopied: string;
    shareCopyFailed: string;
    // MagnetButton (the panel reads its own copy from the client dictionary)
    torrents: string;
    // PlayButton
    play: string;
    playAria: string;
  };
}

export default function DetailActions({
  anilistId,
  episodes,
  progressTotal,
  titleRomaji,
  titleEnglish,
  titleChinese,
  titleNative,
  coverImageUrl,
  shareTitle,
  trailerId,
  trailerLabels,
  labels,
}: DetailActionsProps) {
  // The panel is portaled out of the page's `.poster-scope`, so it cannot
  // inherit the hue: it is read here, off the action row, at the moment of
  // opening — the colour the reader is looking at, sampled cover included.
  const [panel, setPanel] = useState<{ hue: number | null } | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const magnetRef = useRef<HTMLButtonElement | null>(null);
  const openPanel = () => {
    const row = rowRef.current;
    setPanel({ hue: row ? parseHue(getComputedStyle(row).getPropertyValue("--poster-hue")) : null });
  };
  // Safari does not focus a button it clicks; give the magnet button focus
  // itself, so the panel returns focus there and not to whatever held it.
  const openFromMagnet = () => {
    magnetRef.current?.focus({ preventScroll: true });
    openPanel();
  };

  return (
    <>
      <div ref={rowRef} className={styles.row}>
        {/* Compact layouts do not render the cinematic card, so the trailer
            becomes the first stable action. Keep it before the auth-dependent
            subscription control in both DOM and visual order: a subscribed
            reader gets status + progress + score + remove here, and that
            expanding cluster must never push the trailer below itself. */}
        {trailerId ? (
          <TrailerPreview
            trailerId={trailerId}
            title={shareTitle}
            labels={trailerLabels}
            variant="button"
          />
        ) : null}
        <SubscriptionButton
          anilistId={anilistId}
          episodes={progressTotal}
          labels={{
            add: labels.subAdd,
            remove: labels.subRemove,
            login: labels.subLogin,
            loginAria: labels.subLoginAria,
            rate: labels.subRate,
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
          ref={magnetRef}
          onOpen={openFromMagnet}
          label={labels.torrents}
          expanded={panel !== null}
        />
        <PlayButton
          ariaLabel={labels.playAria}
          onOpenDownloads={openPanel}
        >
          {labels.play}
        </PlayButton>
      </div>
      {panel ? (
        <MagnetPanel
          anime={{
            anilistId,
            episodes,
            titleRomaji,
            titleEnglish,
            titleChinese,
            titleNative,
            coverImageUrl,
          }}
          heading={shareTitle}
          hue={panel.hue}
          onClose={() => setPanel(null)}
          returnFocusRef={magnetRef}
        />
      ) : null}
    </>
  );
}
