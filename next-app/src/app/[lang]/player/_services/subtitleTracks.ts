// The subtitle tracks of the episode on screen, and which one is showing.
//
// THREE SOURCES, ONE LIST
//
//   embedded — the text tracks inside an .mkv, read by the scan worker
//   sidecar  — .ass/.srt/.vtt files beside the video (matchSidecars)
//   user     — a file the reader loaded from the subtitle panel
//
// Before this, the player resolved exactly one subtitle per episode: a
// sidecar if there was one, else the first ASS track of an MKV. Everything
// else in the file or the folder was unreachable.
//
// THE INVARIANT THIS FILE OWNS
//
//   A track's `vtt` is ALWAYS a WebVTT document (or null while loading), and
//   `assContent` is the untouched ASS script when the source is ASS.
//
// VideoPlayer hands `vtt` to artplayer as `{ type: "vtt" }` — the bytes are
// used verbatim and artplayer's own SRT/ASS readers never run — and gives
// `assContent` to libass. That pairing is the handshake: plaintext fallback
// underneath, styled rendering on top.
//
// The state is a reducer so every rule about it (when a default is chosen,
// what a late scan result may and may not change, what an error falls back
// to) is checkable from `bun test` without a Worker or a DOM.

import { convertAssToVtt, convertSrtToVtt } from "@/lib/subtitleConvert";
import {
  guessLanguage,
  pickDefaultTrack,
  type SubtitleLang,
  type SubtitlePreference,
} from "@/lib/subtitles/language";
import type { MkvSubtitleFormat, MkvTrackInfo } from "@/lib/subtitles/matroska";
import type { MkvWorkerTrack } from "@/lib/subtitles/workerProtocol";

export type TrackSource = "embedded" | "sidecar" | "user";
export type TrackStatus = "loading" | "partial" | "ready" | "error" | "unsupported";

export interface SubtitleTrack {
  id: string;
  source: TrackSource;
  /** Track name, sidecar descriptor or file name — what the reader sees. */
  name: string;
  /** Sidecar or user file name, for the second line of the menu. */
  fileName: string | null;
  lang: SubtitleLang | null;
  bilingual: boolean;
  format: MkvSubtitleFormat;
  supported: boolean;
  isDefault: boolean;
  isForced: boolean;
  status: TrackStatus;
  vtt: string | null;
  assContent: string | null;
  cueCount: number | null;
}

export type ScanState = "idle" | "scanning" | "done" | "error";

export interface SubtitleTracksState {
  /** The playback this state belongs to; actions for another are ignored. */
  key: string | null;
  tracks: SubtitleTrack[];
  activeId: string | null;
  /**
   * "auto" until the reader picks a track (or "off") themselves. Automatic
   * choices are made once per episode and never overwrite a reader's.
   */
  choice: "auto" | "user";
  /** True once the automatic choice has been made for this episode. */
  decided: boolean;
  /** Waiting on: the MKV's track list, and sidecars still being read. */
  awaitingEmbedded: boolean;
  pendingSidecars: number;
  fonts: Uint8Array[];
  scan: { state: ScanState; fraction: number };
  pref: SubtitlePreference;
  uiLang: string;
}

export const initialSubtitleTracksState: SubtitleTracksState = {
  key: null,
  tracks: [],
  activeId: null,
  choice: "auto",
  decided: false,
  awaitingEmbedded: false,
  pendingSidecars: 0,
  fonts: [],
  scan: { state: "idle", fraction: 0 },
  pref: null,
  uiLang: "zh",
};

export interface SidecarInput {
  id: string;
  name: string;
  fileName: string;
  format: string;
}

export type SubtitleTracksAction =
  | {
      type: "start";
      key: string;
      scanEmbedded: boolean;
      sidecars: SidecarInput[];
      pref: SubtitlePreference;
      uiLang: string;
    }
  | { type: "stop" }
  | { type: "embeddedTracks"; key: string; tracks: MkvTrackInfo[] }
  | { type: "embeddedContent"; key: string; tracks: MkvWorkerTrack[]; final: boolean }
  | { type: "embeddedFailed"; key: string; notMatroska: boolean }
  | { type: "progress"; key: string; fraction: number }
  | { type: "fonts"; key: string; fonts: Uint8Array[] }
  | { type: "sidecarLoaded"; key: string; id: string; vtt: string; assContent: string | null }
  | { type: "sidecarFailed"; key: string; id: string }
  | { type: "userTrack"; key: string; track: SubtitleTrack }
  | { type: "select"; id: string | null };

export const embeddedId = (number: number) => `mkv:${number}`;

function formatOf(ext: string): MkvSubtitleFormat {
  const f = ext.toLowerCase();
  if (f === "ass" || f === "ssa") return "ass";
  if (f === "srt") return "srt";
  if (f === "vtt") return "vtt";
  if (f === "sup" || f === "sub" || f === "idx") return "image";
  return "unknown";
}

function embeddedTrack(info: MkvTrackInfo): SubtitleTrack {
  const guess = guessLanguage({
    name: info.name,
    languageBcp47: info.languageBcp47,
    language: info.language,
  });
  return {
    id: embeddedId(info.number),
    source: "embedded",
    name: info.name,
    fileName: null,
    lang: guess.lang,
    bilingual: guess.bilingual,
    format: info.format,
    supported: info.supported,
    isDefault: info.isDefault,
    isForced: info.isForced,
    status: info.supported ? "loading" : "unsupported",
    vtt: null,
    assContent: null,
    cueCount: null,
  };
}

export function sidecarTrack(input: SidecarInput, source: TrackSource = "sidecar"): SubtitleTrack {
  const format = formatOf(input.format);
  const guess = guessLanguage({ name: input.name });
  const supported = format === "ass" || format === "srt" || format === "vtt";
  return {
    id: input.id,
    source,
    name: input.name,
    fileName: input.fileName,
    lang: guess.lang,
    bilingual: guess.bilingual,
    format,
    supported,
    isDefault: false,
    isForced: false,
    status: supported ? "loading" : "unsupported",
    vtt: null,
    assContent: null,
    cueCount: null,
  };
}

/** Make the automatic choice, if it is due and nothing blocks it. */
function decide(state: SubtitleTracksState): SubtitleTracksState {
  if (state.choice === "user") return state;
  const active = state.tracks.find((t) => t.id === state.activeId);
  // A chosen track that failed is replaced, even after the choice was made.
  const needsFallback = state.decided && active?.status === "error";
  if (state.decided && !needsFallback) return state;
  if (!state.decided && (state.awaitingEmbedded || state.pendingSidecars > 0)) return state;
  const candidates = state.tracks.filter((t) => t.status !== "error");
  const id = pickDefaultTrack(
    candidates.map((t) => ({
      id: t.id,
      lang: t.lang,
      supported: t.supported,
      isDefault: t.isDefault,
      isForced: t.isForced,
      styled: t.format === "ass",
      source: t.source,
    })),
    state.pref,
    state.uiLang,
  );
  return { ...state, activeId: id, decided: true };
}

function patch(
  state: SubtitleTracksState,
  id: string,
  change: Partial<SubtitleTrack>,
): SubtitleTracksState {
  return {
    ...state,
    tracks: state.tracks.map((t) => (t.id === id ? { ...t, ...change } : t)),
  };
}

export function subtitleTracksReducer(
  state: SubtitleTracksState,
  action: SubtitleTracksAction,
): SubtitleTracksState {
  if (action.type === "start") {
    return decide({
      ...initialSubtitleTracksState,
      key: action.key,
      tracks: action.sidecars.map((s) => sidecarTrack(s)),
      awaitingEmbedded: action.scanEmbedded,
      pendingSidecars: action.sidecars.filter((s) => sidecarTrack(s).supported).length,
      scan: { state: action.scanEmbedded ? "scanning" : "idle", fraction: 0 },
      pref: action.pref,
      uiLang: action.uiLang,
    });
  }
  if (action.type === "stop") return initialSubtitleTracksState;
  if (action.type === "select") {
    if (action.id != null && !state.tracks.some((t) => t.id === action.id && t.supported)) return state;
    return { ...state, activeId: action.id, choice: "user", decided: true };
  }
  if (action.key !== state.key) return state;

  switch (action.type) {
    case "embeddedTracks": {
      const embedded = action.tracks.map(embeddedTrack);
      // Embedded tracks are listed first, in file order; sidecars after.
      const others = state.tracks.filter((t) => t.source !== "embedded");
      return decide({ ...state, tracks: [...embedded, ...others], awaitingEmbedded: false });
    }
    case "embeddedContent": {
      const byId = new Map(action.tracks.map((t) => [embeddedId(t.number), t]));
      let tracks = state.tracks.map((t) => {
        const got = byId.get(t.id);
        if (!got || !t.supported) return t;
        return {
          ...t,
          status: (action.final ? "ready" : "partial") as TrackStatus,
          vtt: got.vtt,
          assContent: got.assContent,
          cueCount: got.cueCount,
        };
      });
      // A file whose Tracks element the worker could not report early (or a
      // result arriving first) still gets its tracks listed.
      if (state.awaitingEmbedded || !state.tracks.some((t) => t.source === "embedded")) {
        const known = new Set(tracks.map((t) => t.id));
        const added = action.tracks
          .filter((t) => !known.has(embeddedId(t.number)))
          .map((t) => {
            const base = embeddedTrack(t);
            return t.supported
              ? { ...base, status: (action.final ? "ready" : "partial") as TrackStatus, vtt: t.vtt, assContent: t.assContent, cueCount: t.cueCount }
              : base;
          });
        tracks = [...added, ...tracks];
      }
      return decide({
        ...state,
        tracks,
        awaitingEmbedded: false,
        scan: action.final ? { state: "done", fraction: 1 } : state.scan,
      });
    }
    case "embeddedFailed": {
      const tracks = action.notMatroska
        ? state.tracks.filter((t) => t.source !== "embedded")
        : state.tracks.map((t) =>
            t.source === "embedded" && t.status !== "ready" && t.status !== "unsupported"
              ? { ...t, status: "error" as TrackStatus }
              : t,
          );
      return decide({
        ...state,
        tracks,
        awaitingEmbedded: false,
        scan: { state: action.notMatroska ? "done" : "error", fraction: state.scan.fraction },
      });
    }
    case "progress":
      if (state.scan.state !== "scanning") return state;
      return { ...state, scan: { state: "scanning", fraction: action.fraction } };
    case "fonts":
      return { ...state, fonts: action.fonts };
    case "sidecarLoaded":
      return decide({
        ...patch(state, action.id, { status: "ready", vtt: action.vtt, assContent: action.assContent }),
        pendingSidecars: Math.max(0, state.pendingSidecars - 1),
      });
    case "sidecarFailed":
      return decide({
        ...patch(state, action.id, { status: "error" }),
        pendingSidecars: Math.max(0, state.pendingSidecars - 1),
      });
    case "userTrack": {
      // Listed either way, so the reader sees what happened to their file;
      // shown only if it could be read.
      const tracks = [...state.tracks, action.track];
      if (action.track.status !== "ready") return { ...state, tracks };
      return { ...state, tracks, activeId: action.track.id, choice: "user", decided: true };
    }
  }
  return state;
}

/** The track on screen, if any. */
export function activeTrack(state: SubtitleTracksState): SubtitleTrack | null {
  return state.tracks.find((t) => t.id === state.activeId) ?? null;
}

/**
 * Convert one sidecar subtitle's text to VTT, and say whether libass can use
 * the original.
 *
 * Pure — no File, no Blob, no URL — so the format rules are checkable without
 * a DOM. The raw text is handed back as `assContent` for ASS/SSA precisely
 * because jassub needs the ORIGINAL: the VTT beside it has had every override
 * tag stripped out, which is the whole point of it being the fallback layer.
 */
export function convertSidecarSubtitle(
  text: string,
  format: string,
): { vtt: string; assContent: string | null } {
  const f = (format || "").toLowerCase();
  if (f === "ass" || f === "ssa") {
    return { vtt: convertAssToVtt(text), assContent: text };
  }
  if (f === "srt") {
    return { vtt: convertSrtToVtt(text), assContent: null };
  }
  return { vtt: text, assContent: null };
}

/**
 * Read and convert a subtitle file. NEVER REJECTS: a subtitle that cannot be
 * read must not take the episode down with it — the video still plays.
 */
export async function readSubtitleFile(
  file: File,
  format: string,
): Promise<{ vtt: string; assContent: string | null } | null> {
  try {
    return convertSidecarSubtitle(await file.text(), format);
  } catch (err) {
    console.warn("[subtitles] could not read", file.name, err instanceof Error ? err.message : err);
    return null;
  }
}
