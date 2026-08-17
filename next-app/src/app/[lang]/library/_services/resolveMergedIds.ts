// Which series ids contribute episodes to one merged card.
//
// performMerge is a SOFT merge: it never moves an episode row and never
// deletes the source series. It only appends the source id to the target's
// `mergedFrom`. Everything downstream has to reassemble the card by reading
// across that list — see useSeriesDetail.
//
// The bug this exists to fix: reading `mergedFrom` once is only correct for a
// single merge. Merge A into B, then B into C, and C's override says
// `mergedFrom: [B]` while B's still says `[A]`. A card built from one level
// shows C + B and silently drops every episode that came from A — and because
// useLibrary hides *any* id that appears in *any* mergedFrom, A is gone from
// the grid too. The files are still indexed, still on disk, and reachable from
// nowhere in the UI. Two merges is not an exotic case: it is what happens the
// second time a rescan splits a series.
//
// So: transitive closure, not one hop.

interface OverrideLike {
  /** The series this override belongs to. */
  seriesId?: string;
  /** Ids soft-merged INTO `seriesId`. */
  mergedFrom?: string[];
}

/**
 * Every series id whose episodes belong on `rootId`'s card, `rootId` first.
 *
 * @param overrides every userOverride row (the table is small — one row per
 *   series the user has touched — so scanning it beats N point lookups).
 * @param rootId the series being displayed.
 */
export function resolveMergedSeriesIds(
  overrides: readonly OverrideLike[] | null | undefined,
  rootId: string,
): string[] {
  if (!rootId) return [];

  // seriesId → its direct sources.
  const childrenOf = new Map<string, string[]>();
  for (const o of overrides ?? []) {
    if (!o || typeof o.seriesId !== "string" || !o.seriesId) continue;
    if (!Array.isArray(o.mergedFrom)) continue;
    const kids = o.mergedFrom.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (kids.length) childrenOf.set(o.seriesId, kids);
  }

  // Breadth-first so the order stays "root, its sources, their sources" —
  // stable and readable in the ops log, unlike a recursive descent.
  //
  // `seen` is doing two jobs: de-duplication (the same source can be reached
  // twice through a diamond) and cycle protection. A cycle should be
  // impossible — performMerge refuses a self-merge and appends only — but an
  // override table is user-writable state that survives across versions, and
  // an infinite loop here would hang the detail sheet with no error to read.
  const seen = new Set<string>([rootId]);
  const out: string[] = [rootId];
  const queue: string[] = [rootId];

  while (queue.length) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }

  return out;
}
