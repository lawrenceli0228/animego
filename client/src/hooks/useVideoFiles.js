import { useState, useRef, useCallback, useEffect } from 'react';
import { isVideoFile, isSubtitleFile, parseEpisodeNumber, parseAnimeKeyword, getSubtitleType, parseEpisodeMeta } from '../utils/episodeParser';

/** Soft id: stable within a browser session, matches types.js EpisodeItem.id convention. */
function makeFileId(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** Return the most common value in an array, or undefined if empty. */
function mostCommon(arr) {
  if (!arr.length) return undefined;
  const freq = new Map();
  let best = arr[0];
  let bestN = 0;
  for (const v of arr) {
    const n = (freq.get(v) ?? 0) + 1;
    freq.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

export default function useVideoFiles() {
  const [videoFiles, setVideoFiles] = useState([]);
  const [keyword, setKeyword] = useState('');
  // Map<fileId, blobUrl> — each file keeps its own URL; switching episodes does not revoke others.
  const videoBlobMap = useRef(new Map());
  const subBlobMap = useRef(new Map());

  /**
   * processFiles(fileList, options)
   * options.mode    = 'append' (default) | 'replace'
   * options.pathMap = optional Map<File, string> — relPath override for FSA-imported files
   *                   that have no webkitRelativePath. v3.1 enumerator threads this through
   *                   to preserve directory signal for groupByFolder / clusterize.
   */
  const processFiles = useCallback((fileList, options = {}) => {
    const { mode: mergeMode = 'append', pathMap } = options;
    const allFiles = Array.from(fileList);
    const videos = allFiles.filter(f => isVideoFile(f.name));
    if (!videos.length) return { files: [], keyword: '' };

    // Collect subtitle files from this batch
    const subs = allFiles.filter(f => isSubtitleFile(f.name)).map(f => ({
      file: f,
      fileName: f.name,
      episode: parseEpisodeNumber(f.name),
      type: getSubtitleType(f.name),
    }));

    const parsed = videos.map(file => {
      const episode = parseEpisodeNumber(file.name);
      const meta = parseEpisodeMeta(file.name);
      const matchedSub = episode != null
        ? subs
            .filter(s => s.episode === episode)
            .sort((a, b) => subPriority(a.type) - subPriority(b.type))[0]
        : findSubByName(file.name, subs);
      const overridePath = pathMap?.get?.(file);
      const relPath = overridePath || file.webkitRelativePath || file.name;
      // For files nested under a folder (e.g. `Show/Bonus/clip.mp4`), prefer
      // the outermost folder as the cluster title — bonus/SP folders contain
      // BD extras whose own filenames would otherwise spawn lone "afterimage"
      // / "MV" / "Spoiler" cards.
      const segments = relPath.split('/').filter(Boolean);
      const folderTitle = segments.length > 1
        ? parseAnimeKeyword(segments[0])
        : null;
      return {
        fileId: makeFileId(file),
        file,
        fileName: file.name,
        relativePath: relPath,
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

    // Keyword: mode of parsedTitles across incoming batch, falling back to folder/first-file.
    const parsedTitles = parsed
      .map(f => parseAnimeKeyword(f.relativePath.split('/')[0]) || parseAnimeKeyword(f.fileName))
      .filter(Boolean);
    const kw = mostCommon(parsedTitles) || '';

    // Replace mode discards the prior session — revoke its blob URLs synchronously
    // here, BEFORE queuing the state update, so callers don't have to call clear()
    // first (which would be a separate render and racy with the upcoming setState).
    if (mergeMode === 'replace') {
      videoBlobMap.current.forEach(url => URL.revokeObjectURL(url));
      videoBlobMap.current.clear();
      subBlobMap.current.forEach(url => URL.revokeObjectURL(url));
      subBlobMap.current.clear();
    }

    setVideoFiles(prev => {
      if (mergeMode === 'replace') return parsed;
      // append: skip files already present (same fileId)
      const existingIds = new Set(prev.map(f => f.fileId));
      const incoming = parsed.filter(f => !existingIds.has(f.fileId));
      if (!incoming.length) return prev;
      const merged = [...prev, ...incoming];
      merged.sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999));
      return merged;
    });

    setKeyword(prev => (mergeMode === 'replace' ? kw : (kw || prev)));
    return { files: parsed, keyword: kw };
  }, []);

  /**
   * getVideoUrl(file) — returns a stable blob URL per fileId.
   * Does NOT revoke other files' URLs on call.
   */
  const getVideoUrl = useCallback((file) => {
    const id = makeFileId(file);
    if (!videoBlobMap.current.has(id)) {
      videoBlobMap.current.set(id, URL.createObjectURL(file));
    }
    return videoBlobMap.current.get(id);
  }, []);

  const getSubtitleUrl = useCallback((file) => {
    const id = makeFileId(file);
    if (!subBlobMap.current.has(id)) {
      subBlobMap.current.set(id, URL.createObjectURL(file));
    }
    return subBlobMap.current.get(id);
  }, []);

  const clear = useCallback(() => {
    videoBlobMap.current.forEach(url => URL.revokeObjectURL(url));
    videoBlobMap.current.clear();
    subBlobMap.current.forEach(url => URL.revokeObjectURL(url));
    subBlobMap.current.clear();
    setVideoFiles([]);
    setKeyword('');
  }, []);

  // Revoke all blob URLs on unmount
  useEffect(() => () => {
    videoBlobMap.current.forEach(url => URL.revokeObjectURL(url));
    subBlobMap.current.forEach(url => URL.revokeObjectURL(url));
  }, []);

  return { videoFiles, keyword, processFiles, getVideoUrl, getSubtitleUrl, clear };
}

const SUB_PRIORITY = { ass: 0, ssa: 1, srt: 2, vtt: 3 };
function subPriority(type) { return SUB_PRIORITY[type] ?? 9; }

function findSubByName(videoName, subs) {
  const base = videoName.replace(/\.[^.]+$/, '');
  return subs.find(s => s.fileName.replace(/\.[^.]+$/, '') === base) || null;
}
