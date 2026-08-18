"use client";

// Ported from client/src/hooks/useVideoFiles.js. Processes raw FileList /
// drop-zone files into parsed EpisodeItem[] shape that the import pipeline
// expects. Maintains stable blob URLs per file id so switching episodes
// does not revoke other files' URLs.

import { useState, useRef, useCallback, useEffect } from "react";
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
  type: string;
}

export interface ParsedEpisodeItem {
  fileId: string;
  file: File;
  fileName: string;
  relativePath: string;
  episode: number | null;
  subtitle: SubtitleMatch | null;
  parsedTitle?: string;
  parsedNumber?: number;
  parsedKind?: string;
  parsedGroup?: string;
  parsedResolution?: string;
  parsedSeason?: number;
  parsedEpisodeAlt?: number;
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
  getSubtitleUrl: (file: File) => string;
  clear: () => void;
}

const SUB_PRIORITY: Record<string, number> = { ass: 0, ssa: 1, srt: 2, vtt: 3 };
function subPriority(type: string): number {
  return SUB_PRIORITY[type] ?? 9;
}

function findSubByName(
  videoName: string,
  subs: SubtitleMatch[],
): SubtitleMatch | null {
  const base = videoName.replace(/\.[^.]+$/, "");
  return subs.find((s) => s.fileName.replace(/\.[^.]+$/, "") === base) || null;
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
  const subBlobMap = useRef(new Map<string, string>());

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
        .map((f) => ({
          file: f,
          fileName: f.name,
          episode: parseEpisodeNumber(f.name),
          type: getSubtitleType(f.name),
        }));

      const parsed: ParsedEpisodeItem[] = videos.map((file) => {
        const episode = parseEpisodeNumber(file.name);
        const meta = parseEpisodeMeta(file.name);
        const matchedSub =
          episode != null
            ? subs
                .filter((s) => s.episode === episode)
                .sort((a, b) => subPriority(a.type) - subPriority(b.type))[0]
            : findSubByName(file.name, subs);
        const overridePath = pathMap?.get?.(file);
        // webkitRelativePath is a non-standard File extension; cast for TS.
        const overrideRel = overridePath ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((file as any).webkitRelativePath as string) ||
          file.name;
        const segments = overrideRel.split("/").filter(Boolean);
        const folderTitle =
          segments.length > 1 ? parseAnimeKeyword(segments[0]) : null;
        return {
          fileId: makeFileId(file),
          file,
          fileName: file.name,
          relativePath: overrideRel,
          episode,
          subtitle: matchedSub || null,
          parsedTitle: folderTitle || meta.title,
          parsedNumber: meta.number,
          parsedKind: meta.kind,
          parsedGroup: meta.group,
          parsedResolution: meta.resolution,
          parsedSeason: meta.season,
          parsedEpisodeAlt: meta.episodeAlt,
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
        subBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
        subBlobMap.current.clear();
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

  const getSubtitleUrl = useCallback((file: File): string => {
    const id = makeFileId(file);
    if (!subBlobMap.current.has(id)) {
      subBlobMap.current.set(id, URL.createObjectURL(file));
    }
    return subBlobMap.current.get(id) as string;
  }, []);

  const clear = useCallback(() => {
    videoBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
    videoBlobMap.current.clear();
    subBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
    subBlobMap.current.clear();
    setVideoFiles([]);
    setKeyword("");
  }, []);

  useEffect(
    () => () => {
      videoBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
      subBlobMap.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  return {
    videoFiles,
    keyword,
    processFiles,
    getVideoUrl,
    getSubtitleUrl,
    clear,
  };
}
