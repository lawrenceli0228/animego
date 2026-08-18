"use client";

// Ported from client/src/services/deleteSeries.js. Cascade-delete a Series
// and every IDB record that references it. On-disk video files are NEVER
// deleted — the user's media is theirs.

import type Dexie from "dexie";

interface EpisodeRow {
  id: string;
  seriesId: string;
  primaryFileId?: string;
  alternateFileIds?: string[];
}

interface SeasonRow {
  id: string;
  seriesId: string;
}

export interface DeleteSummary {
  seriesId: string;
  episodes: number;
  seasons: number;
  fileRefs: number;
  progress: number;
  userOverride: boolean;
}

export async function deleteSeriesCascade({
  db,
  seriesId,
}: {
  db: Dexie;
  seriesId: string;
}): Promise<DeleteSummary> {
  if (typeof seriesId !== "string" || !seriesId) {
    throw new Error("deleteSeriesCascade: seriesId must be a non-empty string");
  }

  const summary: DeleteSummary = {
    seriesId,
    episodes: 0,
    seasons: 0,
    fileRefs: 0,
    progress: 0,
    userOverride: false,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  const seriesRow = await tables.series.get(seriesId);
  if (!seriesRow) return summary;

  const episodes = (await tables.episodes
    .where("seriesId")
    .equals(seriesId)
    .toArray()) as EpisodeRow[];
  const seasons = (await tables.seasons
    .where("seriesId")
    .equals(seriesId)
    .toArray()) as SeasonRow[];

  // Collect the fileRef ids referenced by these episodes.
  const fileRefIds = new Set<string>();
  for (const ep of episodes) {
    if (ep.primaryFileId) fileRefIds.add(ep.primaryFileId);
    if (Array.isArray(ep.alternateFileIds)) {
      for (const fid of ep.alternateFileIds) fileRefIds.add(fid);
    }
  }

  // Don't delete a fileRef that some OTHER series still owns.
  const sharedRefIds = new Set<string>();
  if (fileRefIds.size > 0) {
    const otherEpisodes = (await tables.episodes
      .where("seriesId")
      .notEqual(seriesId)
      .toArray()) as EpisodeRow[];
    for (const ep of otherEpisodes) {
      if (ep.primaryFileId && fileRefIds.has(ep.primaryFileId)) {
        sharedRefIds.add(ep.primaryFileId);
      }
      if (Array.isArray(ep.alternateFileIds)) {
        for (const fid of ep.alternateFileIds) {
          if (fileRefIds.has(fid)) sharedRefIds.add(fid);
        }
      }
    }
  }
  const ownedRefIds = Array.from(fileRefIds).filter(
    (id) => !sharedRefIds.has(id),
  );

  await tables.transaction(
    "rw",
    [
      tables.series,
      tables.seasons,
      tables.episodes,
      tables.fileRefs,
      tables.progress,
      tables.userOverride,
    ],
    async () => {
      if (ownedRefIds.length > 0) {
        await tables.fileRefs.bulkDelete(ownedRefIds);
        summary.fileRefs = ownedRefIds.length;
      }
      if (episodes.length > 0) {
        await tables.episodes.bulkDelete(episodes.map((e) => e.id));
        summary.episodes = episodes.length;
      }
      if (seasons.length > 0) {
        await tables.seasons.bulkDelete(seasons.map((s) => s.id));
        summary.seasons = seasons.length;
      }
      const progressDeleted: number = await tables.progress
        .where("seriesId")
        .equals(seriesId)
        .delete();
      summary.progress = progressDeleted;

      const overrideDeleted: number = await tables.userOverride
        .where("seriesId")
        .equals(seriesId)
        .delete();
      summary.userOverride = overrideDeleted > 0;

      await tables.series.delete(seriesId);
    },
  );

  return summary;
}
