"use client";

// Runs the subtitle sources for the episode on screen and keeps their state
// (see _services/subtitleTracks.ts for what that state means and the rules
// it follows). This hook is the part that cannot be a pure function: it owns
// the scan worker, reads sidecar files, and remembers the reader's language.
//
// Invariant carried over from the single-subtitle version: a pending scan is
// stopped before the next play, on back and on unmount, and anything it says
// afterwards is ignored. The worker is terminated rather than cancelled, and
// every action carries the playback key, so a late message from the previous
// episode cannot land on this one.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SubtitleLang, SubtitlePreference } from "@/lib/subtitles/language";
import type { MkvWorkerMessage } from "@/lib/subtitles/workerProtocol";
import {
  activeTrack,
  initialSubtitleTracksState,
  readSubtitleFile,
  sidecarTrack,
  subtitleTracksReducer,
  type SubtitleTrack,
  type SubtitleTracksState,
} from "../_services/subtitleTracks";

export interface SidecarSubtitle {
  file: File;
  fileName: string;
  /** Extension-derived format: "ass" | "ssa" | "srt" | "vtt"; null for others. */
  type: string | null;
  /** What the name says about the file beyond the video's own name ("sc"). */
  descriptor?: string;
}

export interface SubtitleSourceItem {
  fileId: string;
  file: File;
  fileName: string;
  subtitles?: SidecarSubtitle[] | null;
}

export interface UseSubtitleTracksResult {
  state: SubtitleTracksState;
  active: SubtitleTrack | null;
  start: (item: SubtitleSourceItem) => void;
  stop: () => void;
  /** A reader's choice — remembered as their language for later episodes. */
  select: (id: string | null) => void;
  addFile: (file: File) => Promise<void>;
}

const PREF_KEY = "animego:subtitleLang";
const LANGS: readonly string[] = ["zh-Hans", "zh-Hant", "zh", "ja", "en", "ko"];

/**
 * A scan that says nothing for this long is treated as failed. Not a cap on
 * the whole scan: progress messages reset it, so a slow disk reading a large
 * file is fine as long as it keeps moving.
 */
const STALL_MS = 45_000;

function readPref(): SubtitlePreference {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === "off") return "off";
    return v && LANGS.includes(v) ? (v as SubtitleLang) : null;
  } catch {
    return null;
  }
}

function writePref(pref: SubtitlePreference): void {
  try {
    if (pref) localStorage.setItem(PREF_KEY, pref);
  } catch {
    // storage disabled — the choice still applies to this episode
  }
}

function createScanWorker(): Worker {
  return new Worker(new URL("../../../../workers/mkvSubtitle.worker.ts", import.meta.url), {
    type: "module",
  });
}

export function useSubtitleTracks(uiLang: string): UseSubtitleTracksResult {
  const [state, dispatch] = useReducer(subtitleTracksReducer, initialSubtitleTracksState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const workerRef = useRef<Worker | null>(null);
  const stallRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const userSeqRef = useRef(0);

  const stopWorker = useCallback(() => {
    if (stallRef.current) clearTimeout(stallRef.current);
    stallRef.current = null;
    const w = workerRef.current;
    workerRef.current = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
    }
  }, []);

  const stop = useCallback(() => {
    stopWorker();
    dispatch({ type: "stop" });
  }, [stopWorker]);

  useEffect(() => stopWorker, [stopWorker]);

  const start = useCallback(
    (item: SubtitleSourceItem) => {
      stopWorker();
      const key = `${item.fileId}#${++seqRef.current}`;
      const files = item.subtitles ?? [];
      const sidecars = files.map((s, i) => ({
        id: `side:${i}:${s.fileName}`,
        name: s.descriptor ?? s.fileName.replace(/\.[^.]+$/, ""),
        fileName: s.fileName,
        format: (s.type || s.fileName.split(".").pop() || "").toLowerCase(),
      }));
      const isMkv = /\.mkv$/i.test(item.fileName);
      dispatch({ type: "start", key, scanEmbedded: isMkv, sidecars, pref: readPref(), uiLang });

      sidecars.forEach((s, i) => {
        if (!sidecarTrack(s).supported) return;
        readSubtitleFile(files[i].file, s.format).then((out) => {
          if (out) dispatch({ type: "sidecarLoaded", key, id: s.id, vtt: out.vtt, assContent: out.assContent });
          else dispatch({ type: "sidecarFailed", key, id: s.id });
        });
      });

      if (!isMkv) return;
      let worker: Worker;
      try {
        worker = createScanWorker();
      } catch (err) {
        console.warn("[subtitles] scan worker could not start:", err);
        dispatch({ type: "embeddedFailed", key, notMatroska: false });
        return;
      }
      workerRef.current = worker;
      const armStall = () => {
        if (stallRef.current) clearTimeout(stallRef.current);
        stallRef.current = setTimeout(() => {
          console.warn(`[subtitles] scan stalled for ${STALL_MS / 1000}s — giving up on embedded tracks`);
          stopWorker();
          dispatch({ type: "embeddedFailed", key, notMatroska: false });
        }, STALL_MS);
      };
      armStall();
      worker.onmessage = (e: MessageEvent<MkvWorkerMessage>) => {
        const msg = e.data;
        if (!msg) return;
        armStall();
        switch (msg.type) {
          case "tracks":
            dispatch({ type: "embeddedTracks", key, tracks: msg.tracks });
            break;
          case "fonts":
            dispatch({ type: "fonts", key, fonts: msg.fonts.map((f) => f.data) });
            break;
          case "progress":
            dispatch({ type: "progress", key, fraction: msg.fraction });
            break;
          case "partial":
            dispatch({ type: "embeddedContent", key, tracks: msg.tracks, final: false });
            break;
          case "done":
            stopWorker();
            dispatch({ type: "embeddedContent", key, tracks: msg.tracks, final: true });
            break;
          case "error":
            stopWorker();
            if (!msg.notMatroska) {
              console.warn("[subtitles] scan failed:", msg.message);
            }
            dispatch({ type: "embeddedFailed", key, notMatroska: msg.notMatroska });
            break;
        }
      };
      worker.onerror = (err: ErrorEvent) => {
        console.warn("[subtitles] scan worker crashed:", err?.message || "(no message)");
        stopWorker();
        dispatch({ type: "embeddedFailed", key, notMatroska: false });
      };
      worker.postMessage({ file: item.file });
    },
    [stopWorker, uiLang],
  );

  const select = useCallback((id: string | null) => {
    const track = stateRef.current.tracks.find((t) => t.id === id);
    if (id === null) writePref("off");
    else if (track?.lang) writePref(track.lang);
    dispatch({ type: "select", id });
  }, []);

  const addFile = useCallback(async (file: File) => {
    const key = stateRef.current.key;
    if (!key) return;
    const format = (file.name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
    const base = sidecarTrack(
      { id: `user:${++userSeqRef.current}`, name: file.name.replace(/\.[^.]+$/, ""), fileName: file.name, format },
      "user",
    );
    const out = base.supported ? await readSubtitleFile(file, format) : null;
    dispatch({
      type: "userTrack",
      key,
      track: out
        ? { ...base, status: "ready", vtt: out.vtt, assContent: out.assContent }
        : { ...base, status: base.supported ? "error" : "unsupported" },
    });
  }, []);

  return { state, active: activeTrack(state), start, stop, select, addFile };
}
