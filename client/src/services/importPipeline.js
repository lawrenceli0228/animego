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
import { buildSeasonRecord, buildFileRefRecord } from '../lib/library/recordFactory.js';

/**
 * @typedef {{ clusters: number, matched: number, failed: number, ambiguous: number }} ImportSummary
 */

/**
 * Run the full import pipeline for a batch of EpisodeItems.
 *
 * @param {{ items: EpisodeItem[], libraryId: string }} input
 * @param {{
 *   db: import('dexie').Dexie,
 *   dandan: { match(hash16M: string, fileName: string): Promise<any> },
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

  // Stage 3: clusterize
  const clusters = clusterize(groups, priorSeasons);

  /** @type {ImportSummary} */
  const summary = { clusters: clusters.length, matched: 0, failed: 0, ambiguous: 0 };

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
        seriesRepo,
        seasonRepo,
        fileRefRepo,
        cacheRepo,
        dandan,
        db,
        ulidSeed: ulidSeedBase !== undefined ? seedOffset : undefined,
        summary,
        emit,
      });
    } catch (err) {
      summary.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({ kind: 'clusterDone', clusterKey, verdict: 'failed' });
      emit({ kind: 'failed', clusterKey, error: errMsg });
    }

    seedOffset += 100;
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
    cluster, libraryId, priorSeasons, seriesRepo, seasonRepo,
    fileRefRepo, cacheRepo, dandan, ulidSeed, summary, emit,
  } = p;
  const { clusterKey } = cluster;
  const rep = cluster.representative;

  // Check match cache first
  let cachedVerdict = null;
  if (rep?.hash16M) {
    cachedVerdict = await cacheRepo.get(rep.hash16M);
  }

  /** @type {MatchVerdict} */
  let verdict;

  if (cachedVerdict) {
    // Reconstruct verdict from cache — check if it matches a prior season (reuse)
    if (cachedVerdict.kind === 'new' && cachedVerdict.animeId !== undefined) {
      const match = priorSeasons.find(s => s.animeId === cachedVerdict.animeId);
      if (match) {
        verdict = { kind: 'reuse', seriesId: match.seriesId, seasonId: match.id, animeId: match.animeId };
      } else {
        verdict = cachedVerdict;
      }
    } else {
      verdict = cachedVerdict;
    }
  } else {
    // Run local matcher
    verdict = matchSingleCluster(cluster, { priorSeasons, libraryId, ulidSeed });

    if (verdict.kind === 'new') {
      // Call dandanplay to resolve animeId and season
      const dandanResult = await callDandan(dandan, rep);

      if (dandanResult.isAmbiguous) {
        verdict = {
          kind: 'ambiguous',
          candidates: dandanResult.candidates,
        };
      } else if (dandanResult.animeId) {
        // Enrich the verdict with season info
        const seasonRecord = buildSeasonRecord(
          verdict.seriesRecord.id,
          dandanResult.animeId,
          { ulidSeed: ulidSeed !== undefined ? ulidSeed + 1 : undefined }
        );
        verdict = { ...verdict, seasonRecord };
      }
    }
  }

  // Persist based on verdict kind
  if (verdict.kind === 'reuse' || verdict.kind === 'new') {
    if (verdict.kind === 'new') {
      const records = buildPersistPayload(verdict, cluster, libraryId, 'matched');
      await seriesRepo.upsertCluster(records);
    }
    // For reuse, only write fileRefs if they don't already exist
    if (verdict.kind === 'reuse') {
      await persistFileRefsOnly(cluster, libraryId, verdict.seasonId, 'matched', fileRefRepo, p.db ?? null);
    }
    // Cache the verdict
    if (rep?.hash16M) {
      const cachePayload = verdict.kind === 'reuse'
        ? { kind: 'new', animeId: verdict.animeId }
        : (verdict.seasonRecord ? { kind: 'new', animeId: verdict.seasonRecord?.animeId } : { kind: 'new' });
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
 * Call dandanplay and normalize the result.
 * @param {any} dandan
 * @param {EpisodeItem|null} rep
 * @returns {Promise<{ isAmbiguous: boolean, animeId?: number, candidates?: any[] }>}
 */
async function callDandan(dandan, rep) {
  if (!rep) return { isAmbiguous: false };

  const hash16M = rep.hash16M ?? '';
  const fileName = rep.fileName ?? '';
  const result = await dandan.match(hash16M, fileName);

  const animes = result.animes ?? [];

  if (result.isMatched && animes.length === 1) {
    return { isAmbiguous: false, animeId: animes[0].animeId };
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
    return { isAmbiguous: false, animeId: animes[0].animeId };
  }

  return { isAmbiguous: false };
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
 * Write fileRefs for a 'reuse' verdict (no new series/season/episode rows).
 * @param {import('../lib/library/types').MatchCluster} cluster
 * @param {string} libraryId
 * @param {string} seasonId
 * @param {string} matchStatus
 * @param {ReturnType<import('../lib/library/db/fileRefRepo.js').makeFileRefRepo>} fileRefRepo
 * @param {import('dexie').Dexie} db
 */
async function persistFileRefsOnly(cluster, libraryId, seasonId, matchStatus, fileRefRepo, db) {
  const fileRefs = cluster.items.map(it => ({
    ...buildFileRefRecord({ libraryId, episodeId: null, item: it }),
    matchStatus,
  }));
  if (db) {
    await db.fileRefs.bulkPut(fileRefs);
  }
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
