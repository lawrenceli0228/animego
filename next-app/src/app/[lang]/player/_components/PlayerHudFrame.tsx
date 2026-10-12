"use client";

/**
 * PlayerHudFrame — HUD chrome wrapper around <VideoPlayer/>.
 *
 * The video engine itself (artplayer) lives inside <VideoPlayer/> untouched.
 * This component draws the four corner brackets around it and forwards every
 * player prop verbatim; it holds no playback state.
 *
 * It used to also carry a type-on status strip above the video ("STREAM //
 * N COMMENTS // AUTO", "EP 01") and a "// EP 01 //" callsign in the corner.
 * Both restated what the header above already says — the episode number was
 * on screen three times — and the strip cost 40px of height on a page whose
 * player did not fit the window. Ported from legacy
 * client/src/components/player/PlayerHudFrame.jsx.
 */

import type { CSSProperties } from "react";
import { VideoPlayer } from "./VideoPlayer";
import { CornerBrackets } from "@/components/landing/shared/hud";
import type { WatchTick } from "../_hooks/watchProgressPolicy";
import type { UseSubtitleTracksResult } from "../_hooks/useSubtitleTracks";

const s: Record<string, CSSProperties> = {
  frame: { position: "relative" },
};

export interface PlayerHudFrameProps {
  videoUrl: string | null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  danmakuList: any[];
  subtitles: UseSubtitleTracksResult;
  onEnded: () => void;
  onPlaybackError: (err: { kind?: string } | null) => void;
  progressKey: string | null;
  resumeAt?: number | null;
  onProgressTick?: (sec: number) => void;
  /** Forwarded verbatim — the frame is chrome and holds no playback state. */
  onWatchTick?: (tick: WatchTick) => void;
}

export function PlayerHudFrame({
  videoUrl,
  danmakuList,
  subtitles,
  onEnded,
  onPlaybackError,
  progressKey,
  resumeAt = null,
  onProgressTick,
  onWatchTick,
}: PlayerHudFrameProps) {
  return (
    <div style={s.frame}>
      <CornerBrackets inset={-6} size={10} opacity={0.32} />
      <VideoPlayer
        videoUrl={videoUrl}
        danmakuList={danmakuList}
        subtitles={subtitles}
        onEnded={onEnded}
        onPlaybackError={onPlaybackError}
        progressKey={progressKey}
        resumeAt={resumeAt}
        onProgressTick={onProgressTick}
        onWatchTick={onWatchTick}
      />
    </div>
  );
}

export default PlayerHudFrame;
