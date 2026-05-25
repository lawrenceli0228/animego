"use client";

// Ported from client/src/hooks/useSeriesLibraryStatus.js (P6.4 subagent C).
// Combines a live join of episodes → fileRefs (by primaryFileId) with the
// per-library RootStatus from useFileHandles to produce a per-series
// availability label.

import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import type Dexie from "dexie";

export type RootStatus =
  | "idle"
  | "loading"
  | "ready"
  | "disconnected"
  | "denied"
  | "error";

export type SeriesAvailability = "ok" | "partial" | "offline" | "unknown";

interface UseSeriesLibraryIndexResult {
  index: Map<string, Set<string>>;
  ready: boolean;
}

/**
 * Build a Map<seriesId, Set<libraryId>> via a live join of episodes →
 * fileRefs (joined by primaryFileId). Updates reactively when either
 * table changes. `ready` flips true after the first liveQuery emission.
 */
function useSeriesLibraryIndex({ db }: { db: Dexie }): UseSeriesLibraryIndexResult {
  const [index, setIndex] = useState<Map<string, Set<string>>>(new Map());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const sub = liveQuery(async () => {
      const [episodes, fileRefs] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).episodes.toArray(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).fileRefs.toArray(),
      ]);
      const refById = new Map(
        (fileRefs as Array<{ id: string; libraryId?: string }>).map((r) => [
          r.id,
          r,
        ]),
      );
      const map = new Map<string, Set<string>>();
      for (const ep of episodes as Array<{
        seriesId?: string;
        primaryFileId?: string;
      }>) {
        if (!ep?.seriesId || !ep.primaryFileId) continue;
        const ref = refById.get(ep.primaryFileId);
        if (!ref?.libraryId) continue;
        let set = map.get(ep.seriesId);
        if (!set) {
          set = new Set();
          map.set(ep.seriesId, set);
        }
        set.add(ref.libraryId);
      }
      return map;
    }).subscribe({
      next: (v: Map<string, Set<string>>) => {
        setIndex(v);
        setReady(true);
      },
      error: () => {
        setIndex(new Map());
        setReady(true);
      },
    });
    return () => sub.unsubscribe();
  }, [db]);

  return { index, ready };
}

export interface UseSeriesLibraryStatusResult {
  availabilityBySeries: Map<string, SeriesAvailability>;
  offlineLibraryIds: string[];
  ready: boolean;
}

export function useSeriesLibraryStatus({
  db,
  libraryStatus,
}: {
  db: Dexie;
  libraryStatus?: Map<string, RootStatus> | null;
}): UseSeriesLibraryStatusResult {
  const { index: seriesLibIds, ready } = useSeriesLibraryIndex({ db });
  const libStatus =
    libraryStatus instanceof Map ? libraryStatus : new Map<string, RootStatus>();

  const availabilityBySeries = new Map<string, SeriesAvailability>();
  for (const [seriesId, libs] of seriesLibIds) {
    if (libs.size === 0) {
      availabilityBySeries.set(seriesId, "unknown");
      continue;
    }
    let anyOnline = false;
    let anyOffline = false;
    for (const libId of libs) {
      const st = libStatus.get(libId);
      if (st === "ready") anyOnline = true;
      else if (st === "disconnected" || st === "denied" || st === "error")
        anyOffline = true;
      // libraries we never probed (e.g. in-memory drop-zone "mem:" libraryIds)
      // don't move either flag — they'll stay 'unknown' below.
    }
    if (anyOnline && anyOffline)
      availabilityBySeries.set(seriesId, "partial");
    else if (anyOffline) availabilityBySeries.set(seriesId, "offline");
    else if (anyOnline) availabilityBySeries.set(seriesId, "ok");
    else availabilityBySeries.set(seriesId, "unknown");
  }

  const offlineLibraryIds: string[] = [];
  for (const [libId, st] of libStatus) {
    if (st === "disconnected") offlineLibraryIds.push(libId);
  }

  return { availabilityBySeries, offlineLibraryIds, ready };
}
