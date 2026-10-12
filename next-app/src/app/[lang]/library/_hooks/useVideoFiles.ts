"use client";

// Ported from client/src/hooks/useVideoFiles.js. Processes raw FileList /
// drop-zone files into parsed EpisodeItem[] shape that the import pipeline
// expects. Maintains stable blob URLs per file id so switching episodes
// does not revoke other files' URLs.
//
// Each video carries every subtitle file that belongs to it
// (lib/subtitles/sidecars.ts), not the one that sorted first: a release with
// `.sc.ass` and `.tc.ass` beside each episode offers both in the player.

import { useState, useRef, useCallback, useEffect } from "react";
import { dirOf, matchSidecars, sidecarDescriptor } from "@/lib/subtitles/sidecars";
// JS module — local ported copy of client/src/utils/episodeParser.js.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JSDoc-only JS module
import {
  isVideoFile,
  isSubtitleFile,
  parseEpisodeNumber,
  parseAnimeKeyword,
  getSubtitleType,
  parseEpisodeMeta,
} from "./episodeParser.js";

export interface SubtitleMatch {
  file: File;
  fileName: string;
  episode: number | null;
  type: string | null;
  /** Folder relative to the dropped root, when the browser said. */
  dir: string | null;
  /** What the name says beyond the video's own name ("sc", "[简体]"). */
  descriptor?: string;
}

export interface ParsedEpisodeItem {
  fileId: string;
  file: File;
  fileName: string;
  relativePath: string;
  episode: number | null;
  subtitles: SubtitleMatch[];
  parsedTitle?: string;
  parsedNumber?: number;
  parsedKind?: string;
  parsedGroup?: string;
  parsedResolution?: string;
  parsedSeason?: number;
  parsedEpisodeAlt?: number;
  /**
   * Which numbering `episode` is in — "perSeason" | "absolute" | "unknown",
   * decided by episodeParser from the filename alone.
   *
   * Carried, not acted on. The consumers that would use it (the grid's
   * offset inference, the danmaku match request, watchSync's translation)
   * each infer a space today from `episodeOffset` + `totalEpisodes`, and
   * changing what they infer from is a separate change with its own
   * regressions. This lane exists so that when they do, the evidence is
   * already alongside the number instead of having to be re-derived from a
   * filename nobody kept.
   *
   * Absent means unknown — never assume perSeason for a field that was not
   * written.
   */
  parsedNumberSpace?: "perSeason" | "absolute" | "unknown";
}

export interface ProcessFilesOptions {
  mode?: "append" | "replace";
  pathMap?: Map<File, string>;
}

export interface UseVideoFilesResult {
  videoFiles: ParsedEpisodeItem[];
  keyword: string;
  processFiles: (
    fileList: File[] | FileList,
    options?: ProcessFilesOptions,
  ) => { files: ParsedEpisodeItem[]; keyword: string };
  getVideoUrl: (file: File) => string;
  clear: () => void;
}

/** webkitRelativePath is a non-standard File extension. */
function relPathOf(file: File, pathMap?: Map<File, string>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return pathMap?.get?.(file) || ((file as any).webkitRelativePath as string) || null;
}

function makeFileId(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function mostCommon<T>(arr: T[]): T | undefined {
  if (!arr.length) return undefined;
  const freq = new Map<T, number>();
  let best: T = arr[0];
  let bestN = 0;
  for (const v of arr) {
    const n = (freq.get(v) ?? 0) + 1;
    freq.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

export function useVideoFiles(): UseVideoFilesResult {
  const [videoFiles, setVideoFiles] = useState<ParsedEpisodeItem[]>([]);
  const [keyword, setKeyword] = useState("");
  const videoBlobMap = useRef(new Map<string, string>());

  const processFiles = useCallback(
    (
      fileList: File[] | FileList,
      options: ProcessFilesOptions = {},
    ): { files: ParsedEpisodeItem[]; keyword: string } => {
      const { mode: mergeMode = "append", pathMap } = options;
      const allFiles = Array.from(fileList);
      const videos = allFiles.filter((f) => isVideoFile(f.name));
      if (!videos.length) return { files: [], keyword: "" };

      const subs: SubtitleMatch[] = allFiles
        .filter((f) => isSubtitleFile(f.name))
        .map((f) => {
          const rel = relPathOf(f, pathMap);
          return {
            file: f,
            fileName: f.name,
            episode: parseEpisodeNumber(f.name),
            type: getSubtitleType(f.name),
            dir: rel ? dirOf(rel) : null,
          };
        });

      const parsed: ParsedEpisodeItem[] = videos.map((file) => {
        const episode = parseEpisodeNumber(file.name);
        const meta = parseEpisodeMeta(file.name);
        const overrideRel = relPathOf(file, pathMap) || file.name;
        const matched = matchSidecars(
          { fileName: file.name, episode, dir: relPathOf(file, pathMap) ? dirOf(overrideRel) : null },
          subs,
        ).map((sub) => ({ ...sub, descriptor: sidecarDescriptor(file.name, sub.fileName) }));
        const segments = overrideRel.split("/").filter(Boolean);
        const folderTitle =
          segments.length > 1 ? parseAnimeKeyword(segments[0]) : null;
        return {
          fileId: makeFileId(file),
          file,
          fileName: file.name,
          relativePath: overrideRel,
          episode,
          subtitles: matched,
          parsedTitle: folderTitle || meta.title,
          parsedNumber: meta.number,
          parsedKind: meta.kind,
          parsedGroup: meta.group,
          parsedResolution: meta.resolution,
          parsedSeason: meta.season,
          parsedEpisodeAlt: meta.episodeAlt,
          parsedNumberSpace: meta.numberSpace,
        };
      });

      parsed.sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999));

      const parsedTitles = parsed
        .map(
          (f) =>
            parseAnimeKeyword(f.relativePath.split("/")[0]) ||
            parseAnimeKeyword(f.fileName),
        )
        .filter(Boolean) as string[];
      const kw = mostCommon(parsedTitles) || "";

      if (mergeMode === "replace") {
        videoBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
        videoBlobMap.current.clear();
      }

      setVideoFiles((prev) => {
        if (mergeMode === "replace") return parsed;
        const existingIds = new Set(prev.map((f) => f.fileId));
        const incoming = parsed.filter((f) => !existingIds.has(f.fileId));
        if (!incoming.length) return prev;
        const merged = [...prev, ...incoming];
        merged.sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999));
        return merged;
      });

      setKeyword((prev) => (mergeMode === "replace" ? kw : kw || prev));
      return { files: parsed, keyword: kw };
    },
    [],
  );

  const getVideoUrl = useCallback((file: File): string => {
    const id = makeFileId(file);
    if (!videoBlobMap.current.has(id)) {
      videoBlobMap.current.set(id, URL.createObjectURL(file));
    }
    return videoBlobMap.current.get(id) as string;
  }, []);

  const clear = useCallback(() => {
    videoBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
    videoBlobMap.current.clear();
    setVideoFiles([]);
    setKeyword("");
  }, []);

  useEffect(() => {
    const videos = videoBlobMap.current;
    return () => videos.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  return {
    videoFiles,
    keyword,
    processFiles,
    getVideoUrl,
    clear,
  };
}
