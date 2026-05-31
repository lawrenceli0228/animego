import { describe, it, expect } from 'vitest'
import { buildLibraryMatchResult } from '../buildLibraryMatchResult.js'

const baseSeries = {
  id: 'sr_test',
  titleZh: '从零开始的异世界生活',
  titleJa: 'Re Zero kara Hajimeru Isekai Seikatsu',
  titleEn: 'Re:Zero',
  type: 'tv',
  totalEpisodes: 25,
  confidence: 1,
  createdAt: 0,
  updatedAt: 0,
}

function buildEp(overrides = {}) {
  return {
    id: `ep_${overrides.number ?? '0'}_${overrides.kind ?? 'main'}`,
    seriesId: 'sr_test',
    number: 1,
    kind: 'main',
    primaryFileId: 'f1',
    alternateFileIds: [],
    version: 1,
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildLibraryMatchResult', () => {
  it('returns null when seriesDetail is not ready', () => {
    const result = buildLibraryMatchResult({
      status: 'loading',
      series: null,
      episodes: [],
      fileRefByEpisode: new Map(),
    })
    expect(result).toBeNull()
  })

  // Core regression: Re:Zero S1 EP25 has both a main cut (dandanEpisodeId A)
  // and a commentary cut (dandanEpisodeId B). Before the fix, the commentary
  // row last-write-overwrote main in episodeMap, so playback of either file
  // pulled the wrong danmaku track. With the fix, main owns the slot.
  it('keeps the main episode in episodeMap when a commentary cut shares the same number', () => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ number: 25, kind: 'main', episodeId: 1001 }),
        buildEp({ number: 25, kind: 'commentary', episodeId: 9999 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.episodeMap[25].dandanEpisodeId).toBe(1001)
  })

  it('keeps the main episode in episodeMap regardless of commentary iteration order', () => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ number: 25, kind: 'commentary', episodeId: 9999 }),
        buildEp({ number: 25, kind: 'main', episodeId: 1001 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.episodeMap[25].dandanEpisodeId).toBe(1001)
  })

  it('routes commentary files to supplementaryFiles, leaving videoFiles main-clean', () => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ number: 25, kind: 'main', episodeId: 1001 }),
        buildEp({ number: 25, kind: 'commentary', episodeId: 9999 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.videoFiles).toHaveLength(1)
    expect(result.videoFiles[0].parsedKind).toBe('main')
    expect(result.supplementaryFiles).toHaveLength(1)
    expect(result.supplementaryFiles[0].parsedKind).toBe('commentary')
  })

  // SP files keep their existing behavior — they live in videoFiles (not
  // supplementary) and own their own episodeMap slot when their number is
  // unique. We don't want this change to silently re-route SP content.
  it('leaves SP episodes in videoFiles and gives them their own episodeMap slot', () => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ number: 1,  kind: 'main', episodeId: 1001 }),
        buildEp({ number: 99, kind: 'sp',   episodeId: 2002 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.episodeMap[99].dandanEpisodeId).toBe(2002)
    expect(result.supplementaryFiles).toHaveLength(0)
    expect(result.videoFiles.map((f) => f.parsedKind).sort()).toEqual(['main', 'sp'])
  })

  // Commentary-only series (no main cut for the same number) should yield
  // no episodeMap entry — playback will fall through with no danmaku, which
  // is the desired fallback per "弹幕 match 正片".
  it('does not synthesize an episodeMap entry from a commentary-only episode', () => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ number: 25, kind: 'commentary', episodeId: 9999 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.episodeMap[25]).toBeUndefined()
    expect(result.supplementaryFiles).toHaveLength(1)
  })

  // Legacy compatibility: IDB rows written before parser-step-1 may carry
  // kind=undefined. The strict `=== 'commentary'` guard treats them as main,
  // and `episodeListFromSeriesDetail` falls back to `parsedKind: 'main'` via
  // `ep.kind || 'main'`. Lock both halves of that contract in.
  it('treats an episode with undefined kind as main (legacy IDB row)', () => {
    const ep = buildEp({ number: 5, episodeId: 555 })
    delete ep.kind
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [ep],
      fileRefByEpisode: new Map(),
    })
    expect(result.episodeMap[5].dandanEpisodeId).toBe(555)
    expect(result.videoFiles).toHaveLength(1)
    expect(result.supplementaryFiles).toHaveLength(0)
  })

  // BD-extras routing (added 2026-05): NCOP/NCED/PV/menu/bonus/trailer/interview/wp/cm
  // must NOT mix with main episodes in the same lane. Without this, a
  // DBD-Raws S1 import dumps `[NCOP1]` (kind=ncop, episode=10 from `10bit`
  // codec tag) into the main video list and silently overwrites real ep10.
  it.each([
    ['ncop'],
    ['nced'],
    ['pv'],
    ['menu'],
    ['bonus'],
    ['trailer'],
    ['interview'],
    ['wp'],
    ['cm'],
  ])('routes %s kind to supplementaryFiles, never videoFiles', (kind) => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ id: `ep_main_1`, number: 1, kind: 'main', episodeId: 1001 }),
        buildEp({ id: `ep_extra`,  number: 1, kind, episodeId: 9001 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.videoFiles).toHaveLength(1)
    expect(result.videoFiles[0].parsedKind).toBe('main')
    expect(result.supplementaryFiles).toHaveLength(1)
    expect(result.supplementaryFiles[0].parsedKind).toBe(kind)
  })

  // Two commentary cuts on the same episode (e.g. director + cast tracks):
  // both must land in supplementaryFiles, neither owns the episodeMap slot.
  it('keeps multiple commentary cuts at the same episode number, none owning episodeMap', () => {
    const result = buildLibraryMatchResult({
      status: 'ready',
      series: baseSeries,
      episodes: [
        buildEp({ id: 'ep_25_main',     number: 25, kind: 'main',       episodeId: 1001 }),
        buildEp({ id: 'ep_25_dirComm',  number: 25, kind: 'commentary', episodeId: 9990 }),
        buildEp({ id: 'ep_25_castComm', number: 25, kind: 'commentary', episodeId: 9991 }),
      ],
      fileRefByEpisode: new Map(),
    })
    expect(result.episodeMap[25].dandanEpisodeId).toBe(1001)
    expect(result.supplementaryFiles).toHaveLength(2)
    expect(result.videoFiles).toHaveLength(1)
  })
})
