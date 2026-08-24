"use client";
// @ts-check
// Pure orchestration — no React, no DOM.
// Collaborators (db, dandan client) are injected for testability.

/** @typedef {import('@/lib/library/types').EpisodeItem} EpisodeItem */
/** @typedef {import('@/lib/library/types').ImportEvent} ImportEvent */
/** @typedef {import('@/lib/library/types').MatchVerdict} MatchVerdict */
/** @typedef {import('@/lib/library/types').FileRef} FileRef */

import { groupByFolder } from '@/lib/library/grouping.js';
import { clusterize } from '@/lib/library/clusterizer.js';
import { matchSingleCluster } from '@/lib/library/seriesMatcher.js';
import { makeSeriesRepo } from '@/lib/library/db/seriesRepo.js';
import { makeSeasonRepo } from '@/lib/library/db/seasonRepo.js';
import { makeFileRefRepo } from '@/lib/library/db/fileRefRepo.js';
import { makeMatchCacheRepo } from '@/lib/library/db/matchCacheRepo.js';
import {
  buildSeasonRecord,
  buildFileRefRecord,
  buildEpisodeRecord,
  fileRefId,
} from '@/lib/library/recordFactory.js';
import { normalizeTokens } from '@/lib/library/normalize.js';

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

  // Cross-batch home indexes (folder + title). Best-effort: a fake db in
  // tests may not implement toArray on every table — degrade to null and the
  // structural fallbacks simply stay off.
  let homeIndexes = null;
  try {
    homeIndexes = await buildHomeIndexes(db, priorSeasons);
  } catch {
    homeIndexes = null;
  }

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
        homeIndexes,
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

  // A cached bare {kind:'new'} (no animeId — a local-title import whose
  // dandan lookup found nothing) carries no seriesRecord. Adopting it as the
  // verdict crashes buildPersistPayload → upsertCluster on series:undefined
  // and the whole cluster counts as failed on every re-import. Treat it as a
  // cache miss and re-match instead.
  if (cachedVerdict?.kind === 'new' && cachedVerdict.animeId === undefined) {
    cachedVerdict = null;
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
      } else if (dandanResult.enrichment) {
        // Matched, but the response carried no dandanplay id.
        //
        // This is the ordinary case now, not an edge one: `/api/dandanplay/match`
        // does not emit a dandanplay animeId in any of its phases, so the
        // client can only report one when a cached verdict supplies it. What it
        // DOES return is the title and poster, and those are worth having on
        // their own — without them a fresh card is titled after whatever the
        // filename parser scraped out of the folder.
        //
        // No Season row is written here. Identity is what a Season row is for,
        // and we do not have it; `applyEnrichment` enforces that.
        verdict = applyEnrichment(verdict, {
          animeId: undefined,
          enrichment: dandanResult.enrichment,
          ulidSeed,
          seasonNumber: clusterSeason,
        });
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

  // Home guards — three structural signals, strongest first, that stop a
  // 'new' verdict from minting a duplicate card:
  //
  //   1. content hash  — every file already homed on one series (re-import)
  //   2. same folder   — the new episode landed in a directory whose existing
  //                      files all belong to one series (the watch-folder
  //                      case: a brand-new episode dandanplay can't match yet)
  //   3. same title    — normalized title tokens uniquely match one existing
  //                      series, season-compatible (flat download folders)
  //
  // 2 and 3 only apply when the verdict carries NO dandan identity
  // (seasonRecord.animeId): when dandanplay positively identified the content
  // as something new, its answer outranks folder/title heuristics. All three
  // bail to 'new' (manual merge stays the fallback) on any ambiguity.
  if (verdict.kind === 'new' && p.db) {
    let home = await deriveExistingHome(cluster, p.db);
    if (!home && !verdict.seasonRecord?.animeId && p.homeIndexes) {
      home =
        deriveFolderHome(cluster, p.homeIndexes, clusterSeason) ??
        deriveTitleHome(cluster, p.homeIndexes, clusterSeason);
    }
    if (home) {
      verdict = {
        kind: 'reuse',
        seriesId: home.seriesId,
        seasonId: home.seasonId,
        animeId: home.animeId,
      };
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
      // persistFileRefsOnly never writes db.series, but useLibrary's liveQuery
      // only tracks that table — bump updatedAt so the new episode surfaces
      // in NewAdditionsRow (sorted by updatedAt) instead of landing silently.
      await seriesRepo.touchSeries(verdict.seriesId);
      trackFolders(verdict.seriesId);
    }
    // Cache the verdict. A reuse without an animeId (the re-import guard's
    // derived home) would serialize to a bare {kind:'new'} entry — useless
    // since the bare-cache normalization above treats it as a miss — so skip.
    if (rep?.hash16M && !(verdict.kind === 'reuse' && verdict.animeId === undefined)) {
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
 * Build the cross-batch home indexes consumed by deriveFolderHome /
 * deriveTitleHome.
 *
 * - folderIndex: dirname(relPath) → Set<seriesId> over every live
 *   (non-superseded, episode-attached) fileRef. A directory owned by exactly
 *   one series is a strong structural signal for new files landing in it.
 * - titleIndex: normalized-title-token key → seriesId, tombstoned (null) on
 *   collision so only UNIQUE titles ever match.
 * - seasonsBySeries: seriesId → Season[] for season-compatibility checks and
 *   seasonId selection.
 *
 * @param {import('dexie').Dexie} db
 * @param {any[]} priorSeasons
 */
async function buildHomeIndexes(db, priorSeasons) {
  const dirnameOf = (relPath) => {
    const idx = relPath.lastIndexOf('/');
    return idx === -1 ? '__root__' : relPath.slice(0, idx);
  };

  const [fileRefs, episodes, seriesRows] = await Promise.all([
    db.fileRefs.toArray(),
    db.episodes.toArray(),
    db.series.toArray(),
  ]);

  const episodeSeries = new Map();
  for (const ep of episodes) {
    if (ep?.id && ep.seriesId) episodeSeries.set(ep.id, ep.seriesId);
  }

  /** @type {Map<string, Set<string>>} */
  const folderIndex = new Map();
  for (const ref of fileRefs) {
    if (!ref?.relPath || ref.supersededAt || !ref.episodeId) continue;
    const seriesId = episodeSeries.get(ref.episodeId);
    if (!seriesId) continue;
    const dir = dirnameOf(ref.relPath);
    let set = folderIndex.get(dir);
    if (!set) {
      set = new Set();
      folderIndex.set(dir, set);
    }
    set.add(seriesId);
  }

  /** @type {Map<string, string|null>} */
  const titleIndex = new Map();
  for (const s of seriesRows) {
    if (!s?.id) continue;
    const titles = new Set([s.titleZh, s.titleEn, s.titleJa].filter(Boolean));
    for (const title of titles) {
      const tokens = normalizeTokens(title);
      if (!tokens.length) continue;
      const key = tokens.join('|');
      const existing = titleIndex.get(key);
      if (existing === undefined) titleIndex.set(key, s.id);
      else if (existing !== s.id) titleIndex.set(key, null); // collision → tombstone
    }
  }

  /** @type {Map<string, any[]>} */
  const seasonsBySeries = new Map();
  for (const season of priorSeasons ?? []) {
    if (!season?.seriesId) continue;
    const list = seasonsBySeries.get(season.seriesId);
    if (list) list.push(season);
    else seasonsBySeries.set(season.seriesId, [season]);
  }

  return { folderIndex, titleIndex, seasonsBySeries };
}

/**
 * Pick the season to attach reused items to, honoring the cluster's parsed
 * season number. Returns { conflict: true } when the cluster names a season
 * the series demonstrably doesn't have — the caller must NOT merge then
 * (S2 files must not collapse into an S1-only card).
 *
 * @param {any[]|undefined} seasons
 * @param {number|null} clusterSeason
 */
function pickHomeSeason(seasons, clusterSeason) {
  const list = seasons ?? [];
  if (clusterSeason != null) {
    const exact = list.find((s) => s.number === clusterSeason);
    if (exact) return { season: exact };
    if (list.some((s) => s.number != null && s.number !== clusterSeason)) {
      return { conflict: true };
    }
    return { season: null };
  }
  if (list.length === 1) return { season: list[0] };
  return { season: null };
}

/**
 * Structural home #2 — the folder signal. Every directory this cluster's
 * files came from must already be owned by exactly ONE series; mixed or
 * unknown folders bail. This is what merges a brand-new episode (unknown to
 * dandanplay) dropped into an existing show's folder by the watch-folder
 * rescan.
 *
 * @returns {{seriesId: string, seasonId: string|null, animeId: number|undefined}|null}
 */
function deriveFolderHome(cluster, homeIndexes, clusterSeason) {
  const { folderIndex, seasonsBySeries } = homeIndexes;
  const owners = new Set();
  for (const group of cluster.groups ?? []) {
    const set = group?.groupKey ? folderIndex.get(group.groupKey) : undefined;
    if (!set || set.size === 0) return null; // unknown folder → no signal
    for (const id of set) owners.add(id);
    if (owners.size > 1) return null; // mixed folder → ambiguous
  }
  if (owners.size !== 1) return null;
  const seriesId = owners.values().next().value;
  const picked = pickHomeSeason(seasonsBySeries.get(seriesId), clusterSeason);
  if (picked.conflict) return null;
  return {
    seriesId,
    seasonId: picked.season?.id ?? null,
    animeId: picked.season?.animeId,
  };
}

/**
 * Structural home #3 — the title signal, for flat download folders where the
 * folder is shared by many shows. Normalized title tokens must match exactly
 * ONE existing series (collisions are tombstoned at index build) and pass the
 * season-compatibility check.
 *
 * @returns {{seriesId: string, seasonId: string|null, animeId: number|undefined}|null}
 */
function deriveTitleHome(cluster, homeIndexes, clusterSeason) {
  const { titleIndex, seasonsBySeries } = homeIndexes;
  const tokens = cluster.normalizedTokens ?? [];
  if (!tokens.length) return null;
  const seriesId = titleIndex.get(tokens.join('|'));
  if (!seriesId) return null; // absent or tombstoned collision
  const picked = pickHomeSeason(seasonsBySeries.get(seriesId), clusterSeason);
  if (picked.conflict) return null;
  return {
    seriesId,
    seasonId: picked.season?.id ?? null,
    animeId: picked.season?.animeId,
  };
}

/**
 * Resolve the existing "home" (seriesId/seasonId) for a cluster whose every
 * file is already imported. Returns null — guard does not apply — when any
 * file is unknown, any known fileRef is ambiguous (episodeId null), or the
 * files span more than one series (never guess across series).
 *
 * animeId comes back undefined when the home was derived structurally rather
 * than via a dandan match; callers must not cache such verdicts.
 *
 * @param {import('@/lib/library/types').MatchCluster} cluster
 * @param {import('dexie').Dexie} db
 * @returns {Promise<{seriesId: string, seasonId: string|null, animeId: undefined}|null>}
 */
async function deriveExistingHome(cluster, db) {
  let seriesId = null;
  let seasonId = null;
  for (const item of cluster.items) {
    const ref = await db.fileRefs.get(fileRefId(item));
    if (!ref?.episodeId) return null;
    const ep = await db.episodes.get(ref.episodeId);
    if (!ep?.seriesId) return null;
    if (seriesId === null) {
      seriesId = ep.seriesId;
      seasonId = ep.seasonId ?? null;
    } else if (ep.seriesId !== seriesId) {
      return null;
    }
  }
  if (!seriesId) return null;
  return { seriesId, seasonId, animeId: undefined };
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

  // IDENTITY AND METADATA ARE TWO DIFFERENT FACTS, and this function used to
  // treat them as one.
  //
  // A Season row IS the dandanplay identity — `Season.animeId` is its whole
  // reason to exist. Without a usable id there is nothing to identify, and
  // writing the row anyway at 0 is actively dangerous: `dedupeSeries.ts` keys
  // on `typeof season.animeId !== 'number'`, so a stored 0 passes as a real id
  // and folds every id-less series onto a single card.
  //
  // Enrichment is not identity. It is the title and poster that keep a card
  // from being named after whatever the filename parser scraped out of the
  // folder — frequently the fansub group. Withholding it for lack of an id is
  // a user-visible regression with no upside, and it is one this file used to
  // have by accident: both lived inside the caller's `else if (animeId)`
  // branch, so when the automatic path stopped producing an id (see
  // `dandanClient.ts`, where a fallback that substituted a bgm.tv subject id
  // was removed), the titles silently went with it.
  const usableAnimeId =
    typeof animeId === 'number' && Number.isInteger(animeId) && animeId > 0;
  const seasonRecord = usableAnimeId
    ? buildSeasonRecord(
        verdict.seriesRecord.id,
        animeId,
        {
          ulidSeed: ulidSeed !== undefined ? ulidSeed + 1 : undefined,
          ...(seasonNumber != null ? { number: seasonNumber } : {}),
        },
      )
    : undefined;
  if (!enrichment) {
    return seasonRecord ? { ...verdict, seasonRecord } : verdict;
  }

  /** @type {import('@/lib/library/types').Series} */
  const seriesRecord = {
    ...verdict.seriesRecord,
    ...(enrichment.titleZh ? { titleZh: enrichment.titleZh } : {}),
    ...(enrichment.titleEn ? { titleEn: enrichment.titleEn } : {}),
    ...(enrichment.posterUrl ? { posterUrl: enrichment.posterUrl } : {}),
    updatedAt: Date.now(),
  };
  return seasonRecord
    ? { ...verdict, seriesRecord, seasonRecord }
    : { ...verdict, seriesRecord };
}

/**
 * Pull persisted enrichment fields off a Series record so the matchCache can
 * carry them across re-imports (e.g. when seasons are wiped but the cache
 * survives). Returns undefined when nothing useful is set.
 *
 * @param {import('@/lib/library/types').Series|undefined} series
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
  // No Season row means no dandanplay id, and an entry without one is nulled
  // out on read (see the guard above `findReusableSeason`) because adopting it
  // as a verdict would crash on a missing seriesRecord. So there is deliberately
  // nothing to attach here: the enrichment this import just applied WILL be
  // re-fetched on a re-import of the same files. That costs one dandanplay call
  // per id-less cluster and is left alone on purpose — carrying it would mean
  // teaching the read path to use half a cached entry, which is a different
  // change with its own failure modes.
  return { kind: 'new' };
}

/**
 * Build the ClusterPayload for seriesRepo.upsertCluster from a 'new' verdict.
 * @param {MatchVerdict} verdict
 * @param {import('@/lib/library/types').MatchCluster} cluster
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
 * @param {import('@/lib/library/types').MatchCluster} cluster
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
  /** @type {Map<number, import('@/lib/library/types').Episode>} */
  const byNumber = new Map();
  for (const ep of existing) {
    if (typeof ep.number === 'number') byNumber.set(ep.number, ep);
  }

  /** @type {import('@/lib/library/types').Episode[]} */
  const episodesToWrite = [];
  /** @type {import('@/lib/library/types').FileRef[]} */
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
 * @param {import('@/lib/library/types').MatchCluster} cluster
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
