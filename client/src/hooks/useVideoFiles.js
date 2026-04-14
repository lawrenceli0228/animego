import { useState, useRef, useCallback, useEffect } from 'react';
import { isVideoFile, isSubtitleFile, parseEpisodeNumber, parseAnimeKeyword, getSubtitleType } from '../utils/episodeParser';

export default function useVideoFiles() {
  const [videoFiles, setVideoFiles] = useState([]);
  const [keyword, setKeyword] = useState('');
  const blobUrlRef = useRef(null);
  const subBlobUrlRef = useRef(null);

  const processFiles = useCallback((fileList) => {
    const allFiles = Array.from(fileList);
    const videos = allFiles.filter(f => isVideoFile(f.name));
    if (!videos.length) return { files: [], keyword: '' };

    // Collect subtitle files
    const subs = allFiles.filter(f => isSubtitleFile(f.name)).map(f => ({
      file: f,
      fileName: f.name,
      episode: parseEpisodeNumber(f.name),
      type: getSubtitleType(f.name),
    }));

    const parsed = videos.map(file => {
      const episode = parseEpisodeNumber(file.name);
      // Match subtitle by episode number, prefer ASS > SSA > SRT > VTT
      const matchedSub = episode != null
        ? subs
            .filter(s => s.episode === episode)
            .sort((a, b) => subPriority(a.type) - subPriority(b.type))[0]
        : findSubByName(file.name, subs);
      return {
        file,
        fileName: file.name,
        relativePath: file.webkitRelativePath || file.name,
        episode,
        subtitle: matchedSub || null,
      };
    });

    parsed.sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999));

    const folderName = parsed[0]?.relativePath?.split('/')[0];
    const kw = parseAnimeKeyword(folderName) || parseAnimeKeyword(parsed[0]?.fileName) || '';

    setVideoFiles(parsed);
    setKeyword(kw);
    return { files: parsed, keyword: kw };
  }, []);

  const getVideoUrl = useCallback((file) => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = URL.createObjectURL(file);
    return blobUrlRef.current;
  }, []);

  const getSubtitleUrl = useCallback((file) => {
    if (subBlobUrlRef.current) URL.revokeObjectURL(subBlobUrlRef.current);
    subBlobUrlRef.current = URL.createObjectURL(file);
    return subBlobUrlRef.current;
  }, []);

  const clear = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    if (subBlobUrlRef.current) {
      URL.revokeObjectURL(subBlobUrlRef.current);
      subBlobUrlRef.current = null;
    }
    setVideoFiles([]);
    setKeyword('');
  }, []);

  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    if (subBlobUrlRef.current) URL.revokeObjectURL(subBlobUrlRef.current);
  }, []);

  return { videoFiles, keyword, processFiles, getVideoUrl, getSubtitleUrl, clear };
}

const SUB_PRIORITY = { ass: 0, ssa: 1, srt: 2, vtt: 3 };
function subPriority(type) { return SUB_PRIORITY[type] ?? 9; }

function findSubByName(videoName, subs) {
  const base = videoName.replace(/\.[^.]+$/, '');
  return subs.find(s => s.fileName.replace(/\.[^.]+$/, '') === base) || null;
}
