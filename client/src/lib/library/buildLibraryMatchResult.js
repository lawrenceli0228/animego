// @ts-check
// Pure adapter — shape a library Series + Episodes + FileRefs into the same
// `matchResult` envelope that `useDandanMatch` produces for the drop-zone
// flow, so the same EpisodeFileList component renders both surfaces.

/** @typedef {import('./types').Series} Series */
/** @typedef {import('./types').Episode} Episode */
/** @typedef {import('./types').FileRef} FileRef */

/**
 * Build EpisodeItem-compatible rows from IDB episodes + fileRefs. Each item
 * carries `_episodeId` so callers can route library clicks through getFile()
 * (FSA lazy resolve) rather than treating fileItem.file as already loaded.
 * Also threads `_fileRef` so server-match flows can read hash16M / size
 * without an extra IDB lookup.
 *
 * @param {Episode[]} episodes
 * @param {Map<string, FileRef>} fileRefByEpisode
 */
export function episodeListFromSeriesDetail(episodes, fileRefByEpisode) {
  return episodes.map((ep) => {
    const ref = fileRefByEpisode.get(ep.id);
    const fileName = ref ? ref.relPath.split('/').pop() || ref.relPath : `EP${ep.number}`;
    return {
      fileId: ep.id,
      file: null,
      fileName,
      relativePath: ref ? ref.relPath : fileName,
      episode: ep.number,
      parsedKind: ep.kind || 'main',
      _episodeId: ep.id,
      _episodeRecord: ep,
      _fileRef: ref || null,
    };
  });
}

/**
 * Synthesize a matchResult-shaped object from a series + its episodes so the
 * EpisodeFileList / DanmakuPicker / progressKey logic can run unchanged on
 * the library entry path.
 *
 * Returns null when the input isn't ready (status !== 'ready' or series
 * record is missing) so callers can short-circuit on a single nullish check.
 *
 * @param {{ status: string, series: Series|null, episodes: Episode[], fileRefByEpisode: Map<string, FileRef> }} seriesDetail
 */
export function buildLibraryMatchResult(seriesDetail) {
  if (seriesDetail.status !== 'ready' || !seriesDetail.series) return null;
  const series = seriesDetail.series;
  const safePoster = typeof series.posterUrl === 'string' && /^https:\/\//i.test(series.posterUrl)
    ? series.posterUrl
    : null;
  const anime = {
    titleNative: series.titleJa || series.titleEn || series.titleZh || '',
    titleRomaji: series.titleEn || '',
    titleChinese: series.titleZh || '',
    episodes: series.totalEpisodes,
    coverImageUrl: safePoster,
  };
  /** @type {Record<number, { dandanEpisodeId?: number, title?: string }>} */
  const episodeMap = {};
  for (const ep of seriesDetail.episodes) {
    if (ep.number != null) {
      episodeMap[ep.number] = {
        dandanEpisodeId: ep.episodeId,
        title: ep.title || '',
      };
    }
  }
  const videoFiles = episodeListFromSeriesDetail(
    seriesDetail.episodes,
    seriesDetail.fileRefByEpisode,
  );
  return { anime, siteAnime: null, episodeMap, videoFiles };
}
