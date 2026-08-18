"use client";

// Ported from client/src/services/refreshSeriesMetadata.js. Refresh a
// Series record's enrichment fields (titleZh / titleEn / posterUrl) by
// re-asking dandanplay for the match using one of its existing fileRefs.

import type Dexie from "dexie";
import type { DandanClient, DandanEnrichment } from "./dandanClient";

interface SeriesRow {
  id: string;
  titleZh?: string;
  titleEn?: string;
  titleJa?: string;
  posterUrl?: string;
  type?: "tv" | "movie" | "ova" | "web";
  updatedAt?: number;
}

interface EpisodeRow {
  primaryFileId?: string;
  alternateFileIds?: string[];
}

interface FileRefRow {
  id: string;
  hash16M?: string;
  relPath: string;
  size: number;
}

export interface RefreshResult {
  seriesId: string;
  changed: boolean;
  fields: string[];
  skipReason?:
    | "no-fileref"
    | "no-hash"
    | "no-match"
    | "no-enrichment"
    | "unchanged"
    | "error"
    | "unknown";
}

export interface BulkRefreshSummary {
  total: number;
  changed: number;
  skipped: number;
  failed: number;
  results: RefreshResult[];
}

async function findUsableFileRef(
  db: Dexie,
  seriesId: string,
): Promise<FileRefRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  const episodes = (await tables.episodes
    .where("seriesId")
    .equals(seriesId)
    .toArray()) as EpisodeRow[];
  if (!episodes.length) return null;

  const idsToTry: string[] = [];
  for (const ep of episodes) {
    if (ep.primaryFileId) idsToTry.push(ep.primaryFileId);
    if (Array.isArray(ep.alternateFileIds)) {
      for (const fid of ep.alternateFileIds) idsToTry.push(fid);
    }
  }
  if (!idsToTry.length) return null;

  const seen = new Set<string>();
  for (const id of idsToTry) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = (await tables.fileRefs.get(id)) as FileRefRow | undefined;
    if (ref?.hash16M) return ref;
  }
  return null;
}

function diffEnrichment(
  series: SeriesRow,
  enrichment: DandanEnrichment,
): { patch: Partial<SeriesRow>; fields: string[] } | null {
  const patch: Partial<SeriesRow> = {};
  const fields: string[] = [];
  if (enrichment.titleZh && enrichment.titleZh !== series.titleZh) {
    patch.titleZh = enrichment.titleZh;
    fields.push("titleZh");
  }
  if (enrichment.titleEn && enrichment.titleEn !== series.titleEn) {
    patch.titleEn = enrichment.titleEn;
    fields.push("titleEn");
  }
  if (enrichment.posterUrl && enrichment.posterUrl !== series.posterUrl) {
    patch.posterUrl = enrichment.posterUrl;
    fields.push("posterUrl");
  }
  return fields.length ? { patch, fields } : null;
}

interface RefreshOneInput {
  db: Dexie;
  dandan: DandanClient;
  seriesId: string;
  now?: () => number;
}

export async function refreshSeriesMetadata(
  input: RefreshOneInput,
): Promise<RefreshResult> {
  const { db, dandan, seriesId, now = () => Date.now() } = input;

  if (typeof seriesId !== "string" || !seriesId) {
    throw new Error("refreshSeriesMetadata: seriesId must be a non-empty string");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  const series = (await tables.series.get(seriesId)) as SeriesRow | undefined;
  if (!series) {
    throw new Error(
      `refreshSeriesMetadata: series ${seriesId} does not exist`,
    );
  }

  const fileRef = await findUsableFileRef(db, seriesId);
  if (!fileRef) {
    return { seriesId, changed: false, fields: [], skipReason: "no-fileref" };
  }
  if (!fileRef.hash16M) {
    return { seriesId, changed: false, fields: [], skipReason: "no-hash" };
  }

  const fileName = fileRef.relPath.split("/").pop() || fileRef.relPath;
  const result = await dandan.match(fileRef.hash16M, fileName, {
    fileSize: fileRef.size,
  });
  if (!result || !result.isMatched) {
    return { seriesId, changed: false, fields: [], skipReason: "no-match" };
  }
  if (!result.enrichment) {
    return { seriesId, changed: false, fields: [], skipReason: "no-enrichment" };
  }

  const diff = diffEnrichment(series, result.enrichment);
  if (!diff) {
    return { seriesId, changed: false, fields: [], skipReason: "unchanged" };
  }

  await tables.series.update(seriesId, { ...diff.patch, updatedAt: now() });
  return { seriesId, changed: true, fields: diff.fields };
}

interface RefreshAllInput {
  db: Dexie;
  dandan: DandanClient;
  onProgress?: (
    done: number,
    total: number,
    last: RefreshResult | { seriesId: string; error: string },
  ) => void;
  now?: () => number;
}

export async function refreshAllSeriesMetadata(
  input: RefreshAllInput,
): Promise<BulkRefreshSummary> {
  const { db, dandan, onProgress, now = () => Date.now() } = input;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allSeries = (await (db as any).series.toArray()) as SeriesRow[];

  const summary: BulkRefreshSummary = {
    total: allSeries.length,
    changed: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (let i = 0; i < allSeries.length; i++) {
    const seriesId = allSeries[i].id;
    try {
      const r = await refreshSeriesMetadata({ db, dandan, seriesId, now });
      summary.results.push(r);
      if (r.changed) summary.changed++;
      else summary.skipped++;
      if (onProgress) onProgress(i + 1, allSeries.length, r);
    } catch (err) {
      summary.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      summary.results.push({
        seriesId,
        changed: false,
        fields: [],
        skipReason: "error",
      });
      if (onProgress)
        onProgress(i + 1, allSeries.length, { seriesId, error: errMsg });
    }
  }

  return summary;
}
