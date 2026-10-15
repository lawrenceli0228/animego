// The "other versions" lane under a card's episode grid, as data.
//
// An episode holds one primary file and any number of alternates: a second
// release of the same episode found later (another group, another folder) is
// attached to the episode it matches instead of minting a duplicate. Until
// this lane existed, nothing in the UI read `alternateFileIds` — the sheet and
// the player both resolve an episode to its primary — so a whole second
// release could sit in the library with no way to see or play it.
//
// Pure for the same reason `episodeGridModel` is: a rule that only lives in a
// component effect is one bun:test cannot reach.

import type { GridEpisodeRow } from "./episodeGridModel";

/** The `Episode` fields this module reads. See `lib/library/types.js`. */
export interface VersionEpisodeRow extends GridEpisodeRow {
  readonly primaryFileId?: string | null;
  readonly alternateFileIds?: readonly string[] | null;
}

/** The `FileRef` fields this module reads. */
export interface VersionFileRef {
  readonly id: string;
  readonly relPath: string;
  readonly group?: string | null;
  readonly supersededAt?: number | null;
}

export interface OtherVersionEntry {
  /** Stable React key: the file, since one episode can have several. */
  readonly key: string;
  readonly fileRefId: string;
  /** What the chip shows — the same number as its episode's chip in the grid. */
  readonly number: number | null;
  /** `Episode.number` as stored — what the hand-off to /player carries. */
  readonly rawNumber: number | null;
  readonly episode: VersionEpisodeRow;
  readonly fileName: string;
}

export interface OtherVersionGroup {
  readonly key: string;
  /** The folder the files came from, or a root file's release group or name. */
  readonly label: string;
  readonly entries: readonly OtherVersionEntry[];
}

const ROOT_GROUP_PREFIX = "root:";

/** Every alternate file id on these episodes, each once, in first-seen order. */
export function alternateFileIdsOf(episodes: readonly VersionEpisodeRow[]): string[] {
  const seen = new Set<string>();
  for (const row of episodes) {
    for (const id of row.alternateFileIds ?? []) {
      if (id) seen.add(id);
    }
  }
  return [...seen];
}

/** The episode whose primary or alternate is this file, if any. */
export function episodeHoldingFile<T extends VersionEpisodeRow>(
  episodes: readonly T[],
  fileRefId: string | null | undefined,
): T | undefined {
  if (!fileRefId) return undefined;
  return episodes.find(
    (row) => row.primaryFileId === fileRefId || (row.alternateFileIds ?? []).includes(fileRefId),
  );
}

function splitPath(relPath: string): { dir: string | null; name: string } {
  const idx = relPath.lastIndexOf("/");
  return idx === -1
    ? { dir: null, name: relPath }
    : { dir: relPath.slice(0, idx), name: relPath.slice(idx + 1) };
}

/**
 * Where an alternate is filed. Files in a folder group by that folder — a
 * release usually arrives as one. A file at the root has no folder to name, so
 * it groups by its release group, and by its own name without one.
 */
function groupOf(ref: VersionFileRef): { key: string; label: string; fileName: string } {
  const { dir, name } = splitPath(ref.relPath);
  if (dir) {
    return { key: dir, label: dir.split("/").pop() || dir, fileName: name };
  }
  const label = ref.group || name;
  return { key: `${ROOT_GROUP_PREFIX}${label}`, label, fileName: name };
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The alternates of a card's episodes, grouped by where they came from.
 *
 * Left out: a file with no row (deleted since), a row marked superseded (the
 * path now holds other content), and a file that is some episode's primary —
 * that one already has its chip in the grid. A file listed on two episodes is
 * shown once, under the first.
 *
 * Ordering is fixed rather than inherited from Dexie: groups by label, entries
 * by the number shown, then by file id.
 */
export function buildOtherVersions(
  episodes: readonly VersionEpisodeRow[],
  refs: readonly VersionFileRef[],
  displayNumbers: ReadonlyMap<string, number>,
): OtherVersionGroup[] {
  const refById = new Map(refs.map((row) => [row.id, row]));
  const primaries = new Set(
    episodes.map((row) => row.primaryFileId).filter((id): id is string => !!id),
  );
  const ordered = [...episodes].sort((a, b) => byText(a.id, b.id));

  const groups = new Map<string, { label: string; entries: OtherVersionEntry[] }>();
  const listed = new Set<string>();
  for (const episode of ordered) {
    for (const id of episode.alternateFileIds ?? []) {
      const ref = refById.get(id);
      if (!ref || ref.supersededAt || primaries.has(id) || listed.has(id)) continue;
      listed.add(id);

      const { key, label, fileName } = groupOf(ref);
      const raw = typeof episode.number === "number" ? episode.number : null;
      const group = groups.get(key) ?? { label, entries: [] };
      group.entries.push({
        key: id,
        fileRefId: id,
        number: displayNumbers.get(episode.id) ?? raw,
        rawNumber: raw,
        episode,
        fileName,
      });
      groups.set(key, group);
    }
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      entries: [...group.entries].sort((a, b) => {
        const left = a.number ?? Number.MAX_SAFE_INTEGER;
        const right = b.number ?? Number.MAX_SAFE_INTEGER;
        return left !== right ? left - right : byText(a.key, b.key);
      }),
    }))
    .sort((a, b) => byText(a.label, b.label) || byText(a.key, b.key));
}
