// @ts-check
// Pure orchestration — no React, no DOM.
// Collaborators (db, dandan client) are injected for testability.

/** @typedef {import('../lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('../lib/library/types').ImportEvent} ImportEvent */
/** @typedef {import('../lib/library/types').MatchVerdict} MatchVerdict */
/** @typedef {import('../lib/library/types').FileRef} FileRef */

import { groupByFolder } from '../lib/library/grouping.js';
import { clusterize } from '../lib/library/clusterizer.js';
import { matchSingleCluster } from '../lib/library/seriesMatcher.js';
import { makeSeriesRepo } from '../lib/library/db/seriesRepo.js';
import { makeSeasonRepo } from '../lib/library/db/seasonRepo.js';
import { makeFileRefRepo } from '../lib/library/db/fileRefRepo.js';
import { makeMatchCacheRepo } from '../lib/library/db/matchCacheRepo.js';
import {
  buildSeasonRecord,
  buildFileRefRecord,
  buildEpisodeRecord,
  fileRefId,
} from '../lib/library/recordFactory.js';

/**
 * @typedef {Object} DandanEnrichment
 * @property {string} [titleZh]
 * @property {string} [titleEn]
 * @property {string} [posterUrl]
 */

/**
 * @typedef {Object} CrossFolderMerge
 * @property {string}   seriesId
 * @property {string[]} folders   distinct folder keys (groupKey) that contributed files
 *
 * @typedef {{
 *   clusters: number,
 *   matched: number,
 *   failed: number,
 *   ambiguous: number,
 *   crossFolderMerges: CrossFolderMerge[]
 * }} ImportSummary
 */

/**
 * Run the full import pipeline for a batch of EpisodeItems.
 *
 * @param {{ items: EpisodeItem[], libraryId: string }} input
 * @param {{
 *   db: import('dexie').Dexie,
 *   dandan: { match(hash16M: string, fileName: string, opts?: { fileSize?: number }): Promise<any> },
 *   ulidSeedBase?: number,
 *   onEvent?: (e: ImportEvent) => void
 * }} ctx
 * @returns {Promise<ImportSummary>}
 */
export async function runImport(input, ctx) {
  const { items, libraryId } = input;
  const { db, dandan, ulidSeedBase, onEvent } = ctx;

  const emit = onEvent ?? (() => {});

  const seriesRepo = makeSeriesRepo(db);
  const seasonRepo = makeSeasonRepo(db);
  const fileRefRepo = makeFileRefRepo(db);
  const cacheRepo = makeMatchCacheRepo(db);

  // Stage 1: group by folder
  const groups = groupByFolder(items);

  // Stage 2: load prior seasons for animeIdHint resolution
  const priorSeasons = await db.seasons.toArray();

  // Stage 2b: load userOverrides → Map<seriesId, UserOverride> for in-loop lookup.
  // Loaded once at start; mid-run dialog edits won't affect this batch.
  const overrideRows = db.userOverride ? await db.userOverride.toArray() : [];
  const userOverrides = new Map(overrideRows.map((o) => [o.seriesId, o]));

  // Stage 3: clusterize
  const clusters = clusterize(groups, priorSeasons);

  /** @type {ImportSummary} */
  const summary = { clusters: clusters.length, matched: 0, failed: 0, ambiguous: 0, crossFolderMerges: [] };

  /**
   * Track which folders contributed files to each resolved seriesId across the
   * batch. Folder keys come from `Group.groupKey` (the dirname). After all
   * clusters are processed, any seriesId with ≥2 distinct folder keys becomes
   * a cross-folder merge entry — that's the §5.6 auto-merge toast trigger.
   * @type {Map<string, Set<string>>}
   */
  const seriesFolders = new Map();

  // Stage 4: process each cluster independently
  let seedOffset = ulidSeedBase ?? 0;

  for (const cluster of clusters) {
    const { clusterKey } = cluster;
    emit({ kind: 'clusterStart', clusterKey, total: cluster.items.length });

    try {
      await processCluster({
        cluster,
        libraryId,
        priorSeasons,
        userOverrides,
        seriesRepo,
        seasonRepo,
        fileRefRepo,
        cacheRepo,
        dandan,
        db,
        ulidSeed: ulidSeedBase !== undefined ? seedOffset : undefined,
        summary,
        emit,
        seriesFolders,
      });
    } catch (err) {
      summary.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({ kind: 'clusterDone', clusterKey, verdict: 'failed' });
      emit({ kind: 'failed', clusterKey, error: errMsg });
    }

    seedOffset += 100;
  }

  for (const [seriesId, folders] of seriesFolders) {
    if (folders.size >= 2) {
      summary.crossFolderMerges.push({
        seriesId,
        folders: Array.from(folders).sort(),
      });
    }
  }

  emit({ kind: 'finish', summary: { ...summary } });
  return summary;
}

/**
 * Process a single cluster through match → persist → cache flow.
 * @param {object} p
 */
async function processCluster(p) {
  const {
    cluster, libraryId, priorSeasons, userOverrides, seriesRepo, seasonRepo,
    fileRefRepo, cacheRepo, dandan, ulidSeed, summary, emit, seriesFolders,
  } = p;
  const { clusterKey } = cluster;
  const rep = cluster.representative;
  const trackFolders = (seriesId) => {
    if (!seriesFolders || !seriesId) return;
    let set = seriesFolders.get(seriesId);
    if (!set) {
      set = new Set();
      seriesFolders.set(seriesId, set);
    }
    for (const g of cluster.groups || []) {
      if (g?.groupKey) set.add(g.groupKey);
    }
  };

  // Check match cache first
  let cachedVerdict = null;
  if (rep?.hash16M) {
    cachedVerdict = await cacheRepo.get(rep.hash16M);
  }

  /** @type {MatchVerdict} */
  let verdict;

  // Parser-detected season number for THIS cluster (from `[4th]` / `S2` /
  // `第N季` in the filenames). Threads through both the REUSE find and the
  // Season record creation so dandanplay returning a single animeId for
  // multiple seasons of the same anime can't collapse them into one card.
  const clusterSeason = cluster.items?.[0]?.parsedSeason ?? null;

  /**
   * Find an existing priorSeason eligible for REUSE.
   *
   * Same animeId is the primary signal. But when the parser detected a season
   * number on this cluster AND the candidate priorSeason was created for a
   * different season number, treat them as different content. This blocks a
   * dandanplay quirk (same animeId across S1/S2/S4 of the same anime) from
   * merging clearly-distinct seasons into one Series.
   *
   * Legacy callers without parsedSeason (and most fansub-variant cases the
   * existing tests cover) fall through unchanged — the season guard only
   * kicks in when BOTH sides carry an explicit, conflicting season number.
   */
  const findReusableSeason = (animeId) =>
    priorSeasons.find((s) => {
      if (s.animeId !== animeId) return false;
      if (clusterSeason != null && s.number != null && s.number !== clusterSeason) return false;
      return true;
    });

  if (cachedVerdict) {
    // Reconstruct verdict from cache — check if it matches a prior season (reuse)
    if (cachedVerdict.kind === 'new' && cachedVerdict.animeId !== undefined) {
      const match = findReusableSeason(cachedVerdict.animeId);
      if (match) {
        verdict = { kind: 'reuse', seriesId: match.seriesId, seasonId: match.id, animeId: match.animeId };
      } else {
        // Cache has animeId but the season was wiped — rebuild via the local
        // matcher and reuse cached enrichment so we skip the dandan call.
        verdict = matchSingleCluster(cluster, { priorSeasons, libraryId, ulidSeed });
        if (verdict.kind === 'new') {
          verdict = applyEnrichment(verdict, {
            animeId: cachedVerdict.animeId,
            enrichment: cachedVerdict.enrichment ?? null,
            ulidSeed,
            seasonNumber: clusterSeason,
          });
        }
      }
    } else {
      verdict = cachedVerdict;
    }
  } else {
    // Run local matcher
    verdict = matchSingleCluster(cluster, { priorSeasons, libraryId, ulidSeed });

    if (verdict.kind === 'new') {
      // Call dandanplay to resolve animeId, season, and enrichment metadata
      const dandanResult = await callDandan(dandan, rep);

      if (dandanResult.isAmbiguous) {
        verdict = {
          kind: 'ambiguous',
          candidates: dandanResult.candidates,
        };
      } else if (dandanResult.animeId) {
        // Reuse an existing series when one already owns a season with this
        // animeId — prevents a duplicate card every time the user re-imports
        // the same anime under a different folder. The cached-verdict branch
        // above already does this; the fresh-match branch was missing it.
        const existing = findReusableSeason(dandanResult.animeId);
        if (existing) {
          verdict = {
            kind: 'reuse',
            seriesId: existing.seriesId,
            seasonId: existing.id,
            animeId: existing.animeId,
          };
        } else {
          verdict = applyEnrichment(verdict, {
            animeId: dandanResult.animeId,
            enrichment: dandanResult.enrichment ?? null,
            ulidSeed,
            seasonNumber: clusterSeason,
          });
        }
      }
    }
  }

  // userOverride routing: if the user pinned a different season under this
  // series, swap the verdict to reuse the override target. We never fabricate
  // seasons — if the target animeId isn't already a known season, fall through
  // so the user notices the missing target rather than getting silent garbage.
  if (verdict?.kind === 'reuse' && userOverrides) {
    const override = userOverrides.get(verdict.seriesId);
    const target = override?.overrideSeasonAnimeId;
    if (target !== undefined && target !== verdict.animeId) {
      const targetSeason = priorSeasons.find(
        (s) => s.seriesId === verdict.seriesId && s.animeId === target,
      );
      if (targetSeason) {
        verdict = {
          kind: 'reuse',
          seriesId: targetSeason.seriesId,
          seasonId: targetSeason.id,
          animeId: targetSeason.animeId,
        };
      }
    }
  }

  // Persist based on verdict kind
  if (verdict.kind === 'reuse' || verdict.kind === 'new') {
    if (verdict.kind === 'new') {
      const records = buildPersistPayload(verdict, cluster, libraryId, 'matched');
      await seriesRepo.upsertCluster(records);
      // Push the freshly persisted season onto priorSeasons so later clusters
      // in the SAME batch can dedupe against it. Without this, three folders
      // of the same anime imported together would create three series each
      // because priorSeasons was snapshot before the loop started.
      if (verdict.seasonRecord) {
        priorSeasons.push(verdict.seasonRecord);
      }
      trackFolders(verdict.seriesRecord?.id);
    }
    // For reuse, only write fileRefs if they don't already exist
    if (verdict.kind === 'reuse') {
      await persistFileRefsOnly(
        cluster,
        libraryId,
        verdict.seriesId,
        verdict.seasonId,
        'matched',
        p.db ?? null,
        ulidSeed,
      );
      trackFolders(verdict.seriesId);
    }
    // Cache the verdict
    if (rep?.hash16M) {
      const cachePayload = buildCachePayload(verdict);
      await cacheRepo.put(rep.hash16M, cachePayload);
    }
    summary.matched++;
    emit({ kind: 'clusterDone', clusterKey, verdict: 'matched' });
  } else if (verdict.kind === 'ambiguous') {
    // Write fileRefs with matchStatus='ambiguous', do NOT persist episodes
    await persistAmbiguousFileRefs(cluster, libraryId, p.db);
    if (rep?.hash16M) {
      await cacheRepo.put(rep.hash16M, { kind: 'ambiguous', candidates: verdict.candidates });
    }
    summary.ambiguous++;
    emit({ kind: 'clusterDone', clusterKey, verdict: 'ambiguous' });
  } else {
    // failed
    summary.failed++;
    emit({ kind: 'clusterDone', clusterKey, verdict: 'failed' });
  }
}

/**
 * Call dandanplay and normalize the result. Forwards an optional `enrichment`
 * blob carrying titleZh/titleEn/posterUrl when the client returned them — the
 * caller patches these onto the Series record so library cards show the real
 * title and cover instead of the anitomy-derived fansub group fallback.
 *
 * @param {any} dandan
 * @param {EpisodeItem|null} rep
 * @returns {Promise<{ isAmbiguous: boolean, animeId?: number, candidates?: any[], enrichment?: DandanEnrichment }>}
 */
async function callDandan(dandan, rep) {
  if (!rep) return { isAmbiguous: false };

  const hash16M = rep.hash16M ?? '';
  const fileName = rep.fileName ?? '';
  const fileSize = rep.file?.size ?? 0;
  const result = await dandan.match(hash16M, fileName, { fileSize });

  if (!result) return { isAmbiguous: false };

  const animes = result.animes ?? [];
  const enrichment = result.enrichment;

  if (result.isMatched && animes.length === 1) {
    return { isAmbiguous: false, animeId: animes[0].animeId, enrichment };
  }

  if (!result.isMatched && animes.length > 1) {
    const candidates = animes.map(a => ({
      animeId: a.animeId,
      animeTitle: a.animeTitle,
      score: 1,
    }));
    return { isAmbiguous: true, candidates };
  }

  if (animes.length >= 1) {
    return { isAmbiguous: false, animeId: animes[0].animeId, enrichment };
  }

  return { isAmbiguous: false };
}

/**
 * Promote a 'new' verdict with the resolved animeId by attaching a fresh
 * Season record and folding any enrichment fields into the Series record.
 * No-op when the verdict is missing seriesRecord (defensive guard).
 *
 * `seasonNumber` is sourced from the parser (`[4th]` / `S2` / `第N季`) so
 * the persisted Season record carries the real season ordinal instead of the
 * legacy `1` default. The REUSE find logic relies on this to reject merging
 * S1 + S2 of the same anime when dandanplay returns a single animeId.
 *
 * @param {MatchVerdict} verdict
 * @param {{ animeId: number, enrichment: DandanEnrichment|null, ulidSeed?: number, seasonNumber?: number|null }} ctx
 * @returns {MatchVerdict}
 */
function applyEnrichment(verdict, { animeId, enrichment, ulidSeed, seasonNumber }) {
  if (!verdict.seriesRecord) return verdict;
  const seasonRecord = buildSeasonRecord(
    verdict.seriesRecord.id,
    animeId,
    {
      ulidSeed: ulidSeed !== undefined ? ulidSeed + 1 : undefined,
      ...(seasonNumber != null ? { number: seasonNumber } : {}),
    },
  );
  if (!enrichment) return { ...verdict, seasonRecord };

  /** @type {import('../lib/library/types').Series} */
  const seriesRecord = {
    ...verdict.seriesRecord,
    ...(enrichment.titleZh ? { titleZh: enrichment.titleZh } : {}),
    ...(enrichment.titleEn ? { titleEn: enrichment.titleEn } : {}),
    ...(enrichment.posterUrl ? { posterUrl: enrichment.posterUrl } : {}),
    updatedAt: Date.now(),
  };
  return { ...verdict, seriesRecord, seasonRecord };
}

/**
 * Pull persisted enrichment fields off a Series record so the matchCache can
 * carry them across re-imports (e.g. when seasons are wiped but the cache
 * survives). Returns undefined when nothing useful is set.
 *
 * @param {import('../lib/library/types').Series|undefined} series
 * @returns {DandanEnrichment|undefined}
 */
function extractEnrichment(series) {
  if (!series) return undefined;
  /** @type {DandanEnrichment} */
  const out = {};
  if (series.titleZh) out.titleZh = series.titleZh;
  if (series.titleEn) out.titleEn = series.titleEn;
  if (series.posterUrl) out.posterUrl = series.posterUrl;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Compose the matchCache payload from a positive verdict.
 *
 * @param {MatchVerdict} verdict
 * @returns {{ kind: 'new', animeId?: number, enrichment?: DandanEnrichment }}
 */
function buildCachePayload(verdict) {
  if (verdict.kind === 'reuse') {
    return { kind: 'new', animeId: verdict.animeId };
  }
  if (verdict.seasonRecord) {
    const enrichment = extractEnrichment(verdict.seriesRecord);
    return enrichment
      ? { kind: 'new', animeId: verdict.seasonRecord.animeId, enrichment }
      : { kind: 'new', animeId: verdict.seasonRecord.animeId };
  }
  return { kind: 'new' };
}

/**
 * Build the ClusterPayload for seriesRepo.upsertCluster from a 'new' verdict.
 * @param {MatchVerdict} verdict
 * @param {import('../lib/library/types').MatchCluster} cluster
 * @param {string} libraryId
 * @param {string} matchStatus
 */
function buildPersistPayload(verdict, cluster, libraryId, matchStatus) {
  const series = verdict.seriesRecord;
  const season = verdict.seasonRecord ?? undefined;
  const episodes = (verdict.episodeRecords ?? []).map(ep => ({
    ...ep,
    ...(season ? { seasonId: season.id } : {}),
  }));
  const fileRefs = (verdict.fileRefRecords ?? []).map(fr => ({
    ...fr,
    matchStatus,
    libraryId,
  }));
  return { series, season, episodes, fileRefs };
}

/**
 * Persist a 'reuse' verdict's items into an existing series. We re-use the
 * series + season but still need Episode rows for any episode number the
 * existing series doesn't yet cover (e.g. another fansub release of the same
 * anime resolved to the same dandan animeId — its episode numbers may not
 * overlap with the original import). Items whose episode number IS already
 * covered get attached as alternateFileIds on the existing Episode.
 *
 * @param {import('../lib/library/types').MatchCluster} cluster
 * @param {string} libraryId
 * @param {string} seriesId
 * @param {string} seasonId
 * @param {string} matchStatus
 * @param {import('dexie').Dexie} db
 * @param {number} [ulidSeed]
 */
async function persistFileRefsOnly(cluster, libraryId, seriesId, seasonId, matchStatus, db, ulidSeed) {
  if (!db) return;

  // Snapshot the existing episodes for this series so the cluster items can
  // either link onto them (alternate source) or create a new row if the
  // number is new.
  const existing = await db.episodes.where('seriesId').equals(seriesId).toArray();
  /** @type {Map<number, import('../lib/library/types').Episode>} */
  const byNumber = new Map();
  for (const ep of existing) {
    if (typeof ep.number === 'number') byNumber.set(ep.number, ep);
  }

  /** @type {import('../lib/library/types').Episode[]} */
  const episodesToWrite = [];
  /** @type {import('../lib/library/types').FileRef[]} */
  const fileRefs = [];
  let seedOffset = 0;

  for (const item of cluster.items) {
    const refId = fileRefId(item);
    let targetEp = item.episode != null ? byNumber.get(item.episode) : undefined;

    if (!targetEp) {
      // Number is new for this series — create an Episode so the file shows
      // up in the merged card. ulidSeed offset stays unique by counting only
      // newly-created episodes inside this cluster.
      targetEp = buildEpisodeRecord({
        seriesId,
        seasonId,
        item,
        ulidSeed: ulidSeed !== undefined ? ulidSeed + 100 + seedOffset : undefined,
      });
      seedOffset++;
      episodesToWrite.push(targetEp);
      if (item.episode != null) byNumber.set(item.episode, targetEp);
    } else if (targetEp.primaryFileId !== refId) {
      // Episode exists but for a different file — record this as an
      // alternate source (multi-resolution / multi-fansub for the same ep).
      const alts = Array.isArray(targetEp.alternateFileIds) ? targetEp.alternateFileIds : [];
      if (!alts.includes(refId)) {
        const updatedEp = {
          ...targetEp,
          alternateFileIds: [...alts, refId],
          updatedAt: Date.now(),
        };
        episodesToWrite.push(updatedEp);
        byNumber.set(item.episode, updatedEp);
        targetEp = updatedEp;
      }
    }

    fileRefs.push({
      ...buildFileRefRecord({ libraryId, episodeId: targetEp.id, item }),
      matchStatus,
    });
  }

  if (episodesToWrite.length) await db.episodes.bulkPut(episodesToWrite);
  await db.fileRefs.bulkPut(fileRefs);
}

/**
 * Write fileRefs with matchStatus='ambiguous' (no episodes).
 * @param {import('../lib/library/types').MatchCluster} cluster
 * @param {string} libraryId
 * @param {import('dexie').Dexie} db
 */
async function persistAmbiguousFileRefs(cluster, libraryId, db) {
  const fileRefs = cluster.items.map(it => ({
    ...buildFileRefRecord({ libraryId, episodeId: null, item: it }),
    matchStatus: 'ambiguous',
  }));
  await db.fileRefs.bulkPut(fileRefs);
}
