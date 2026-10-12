import { describe, expect, test } from "bun:test";
import { createRescanController, MIN_SCAN_INTERVAL_MS } from "./rescanController.js";
import { buildBaseline, diffScanRoot, markSuperseded } from "./rescanService.js";
import { runImport } from "./importPipeline.js";
import { fileRefId } from "@/lib/library/recordFactory.js";
import { memoryDb, recordingDandan } from "@/lib/library/__tests__/memoryDb.js";

// End to end through the real scan: enumerator → baseline diff → controller →
// import pipeline, against an in-memory library and in-memory folder trees.
//
// Reproduces a library reported in the wild: after the user sorted their
// downloads into per-show folders, one episode existed twice on disk (copied,
// not moved). Every scan imported whichever copy the library did not name and
// rewrote its one row to that path, so the next scan found the other copy.
// The library announced "found 1 new episode" on every tab return, bumped the
// card into "new additions", and asked dandanplay each time.

const NOW = 1_800_000_000_000;
const OLD = NOW - 24 * 3_600_000; // well outside the quiet period
const MB = 1024 * 1024;

// ---- in-memory folder trees the real enumerator can walk -------------------

function file(name, content, size, mtime = OLD) {
  return { kind: "file", name, content, size, mtime };
}

function dir(name, children) {
  return { kind: "directory", name, children };
}

/** FileSystemDirectoryHandle-shaped view over a mutable tree node. */
function handleFor(node) {
  if (node.kind === "file") {
    return {
      kind: "file",
      name: node.name,
      getFile: async () => ({
        name: node.name,
        size: node.size,
        lastModified: node.mtime,
        content: node.content,
      }),
    };
  }
  return {
    kind: "directory",
    name: node.name,
    async *values() {
      for (const child of node.children) yield handleFor(child);
    },
  };
}

function folderAt(tree, folderPath) {
  let node = tree;
  for (const part of folderPath.split("/").filter(Boolean)) {
    let next = node.children.find((c) => c.name === part);
    if (!next) {
      next = dir(part, []);
      node.children.push(next);
    }
    node = next;
  }
  return node;
}

/** Removes the entry at `path` ("a/b.mkv") from the tree and returns it. */
function take(tree, path) {
  const parts = path.split("/");
  const name = parts.pop();
  const folder = folderAt(tree, parts.join("/"));
  const index = folder.children.findIndex((c) => c.name === name);
  return folder.children.splice(index, 1)[0];
}

/** Puts `entry` under the folder at `folderPath` ("" for the root). */
function place(tree, folderPath, entry) {
  folderAt(tree, folderPath).children.push(entry);
}

/** Whether playback could open (libraryId, relPath): selectFileByName's walk. */
function playable(roots, libraryId, relPath) {
  const root = roots.find((r) => r.libraryId === libraryId);
  if (!root) return false;
  let node = root.tree;
  for (const part of relPath.split("/")) {
    node = node.children?.find((c) => c.name === part);
    if (!node) return false;
  }
  return node.kind === "file";
}

// ---- the library side -------------------------------------------------------

/**
 * Stands in for useVideoFiles.processFiles + useImport's hash phase: the
 * tree's `content` plays the part of the 16MB md5.
 */
function processFiles(files, { pathMap }) {
  return {
    files: files.map((f) => ({
      fileId: `${f.name}|${f.size}|${f.lastModified}`,
      file: f,
      fileName: f.name,
      relativePath: pathMap.get(f),
      episode: Number(f.name.match(/E(\d+)/)?.[1] ?? NaN) || null,
      parsedKind: "main",
      parsedTitle: "Re Zero",
      hash16M: f.content,
      subtitle: null,
    })),
  };
}

const SIZE = 900 * MB;
const refOf = (content, size = SIZE) =>
  fileRefId({ hash16M: content, file: { size }, fileName: "" });

/** Episode `number` is already in the library, recorded at (libraryId, path). */
function libraryHolding(
  recordedPath,
  { content = "h9", number = 9, size = SIZE, libraryId = "lib-1" } = {},
) {
  const ref = refOf(content, size);
  return memoryDb({
    series: [{ id: "sr-1", titleZh: "Re Zero", createdAt: 1, updatedAt: 1 }],
    episodes: [
      {
        id: `ep-${number}`,
        seriesId: "sr-1",
        number,
        kind: "main",
        primaryFileId: ref,
        alternateFileIds: [],
        updatedAt: 1,
      },
    ],
    fileRefs: [
      {
        id: ref,
        libraryId,
        episodeId: `ep-${number}`,
        relPath: recordedPath,
        size,
        mtime: OLD,
        hash16M: content,
        matchStatus: "matched",
      },
    ],
  });
}

/**
 * @param {any} db
 * @param {any} rootsOrTree  one tree (registered as lib-1), or
 *   [{ libraryId, tree, lastSeenAt? }] for several library folders
 */
function scanner(db, rootsOrTree) {
  const roots = Array.isArray(rootsOrTree)
    ? rootsOrTree
    : [{ libraryId: "lib-1", tree: rootsOrTree }];
  const dandan = recordingDandan();
  let time = NOW;
  const controller = createRescanController({
    isFsaSupported: () => true,
    listRoots: async () =>
      roots.map((r, i) => ({
        id: `rec-${r.libraryId}`,
        libraryId: r.libraryId,
        lastSeenAt: r.lastSeenAt ?? roots.length - i,
        handle: handleFor(r.tree),
      })),
    probeRoot: async () => "ready",
    isSameEntry: async () => false,
    buildBaseline: () => buildBaseline(db),
    diffScanRoot,
    markSuperseded: (candidates, now, libraryIds) =>
      markSuperseded(db, candidates, now, libraryIds),
    processFiles,
    runImport: (p) => runImport(p, { db, dandan }),
    getImportStatus: () => "idle",
    onBeforeSilentRun: () => {},
    onScanComplete: () => {},
    refreshHandles: async () => {},
    now: () => time,
    sleep: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return {
    dandan,
    roots,
    /** The clock reading the next scan() will run at. */
    nextScanAt: () => time + MIN_SCAN_INTERVAL_MS + 1_000,
    /** One tab-return scan, past the throttle. */
    scan: async () => {
      time += MIN_SCAN_INTERVAL_MS + 1_000;
      return controller.maybeScan({ trigger: "visibility" });
    },
  };
}

const S04E09 = "[Sub] Re Zero S04E09.mkv";

describe("two copies of one episode on disk", () => {
  test("settle after one scan: never announced as new, row stops moving", async () => {
    const tree = dir("animePlayList", [
      dir("Re Zero", [file(S04E09, "h9", SIZE)]),
      file(S04E09, "h9", SIZE),
    ]);
    const db = libraryHolding(`Re Zero/${S04E09}`);
    const { scan, dandan } = scanner(db, tree);

    const results = [await scan(), await scan(), await scan()];

    expect(results.map((r) => r.newCount)).toEqual([0, 0, 0]);
    // The first scan records the second copy; after that there is nothing to do.
    expect(results.map((r) => r.relinkedCount)).toEqual([1, 0, 0]);
    const row = db.fileRefs.rows.get(refOf("h9"));
    expect(row.relPath).toBe(`Re Zero/${S04E09}`);
    expect(row.copies).toEqual([{ libraryId: "lib-1", relPath: S04E09 }]);
    expect(db.series.rows.get("sr-1").updatedAt).toBe(1);
    expect(dandan.calls).toHaveLength(0);
  });

  test("deleting the copy the row names hands the row to the remaining copy", async () => {
    const tree = dir("animePlayList", [
      dir("Re Zero", [file(S04E09, "h9", SIZE)]),
      file(S04E09, "h9", SIZE),
    ]);
    const db = libraryHolding(`Re Zero/${S04E09}`);
    const { scan, dandan } = scanner(db, tree);
    await scan();

    take(tree, `Re Zero/${S04E09}`);
    const takeover = await scan();
    const after = await scan();

    expect(takeover.newCount).toBe(0);
    expect(takeover.relinkedCount).toBe(1);
    expect(after.relinkedCount).toBe(0);
    const row = db.fileRefs.rows.get(refOf("h9"));
    expect(row.relPath).toBe(S04E09);
    expect(row.copies).toBeUndefined();
    expect(dandan.calls).toHaveLength(0);
  });

  test("with two listed copies left, one takes over and neither counts as a failure", async () => {
    const tree = dir("animePlayList", [
      dir("Re Zero", [file(S04E09, "h9", SIZE)]),
      file(S04E09, "h9", SIZE),
      dir("Backup", [file(S04E09, "h9", SIZE)]),
    ]);
    const db = libraryHolding(`Re Zero/${S04E09}`);
    const { scan } = scanner(db, tree);
    await scan();
    expect(db.fileRefs.rows.get(refOf("h9")).copies).toHaveLength(2);

    take(tree, `Re Zero/${S04E09}`);
    const takeover = await scan();
    const after = await scan();

    expect(takeover.failedCount).toBe(0);
    expect(after.relinkedCount).toBe(0);
    const row = db.fileRefs.rows.get(refOf("h9"));
    expect([S04E09, `Backup/${S04E09}`]).toContain(row.relPath);
    expect(row.copies).toHaveLength(1);
  });

  test("a listed copy rewritten moments ago waits out the quiet period before it is hashed", async () => {
    const tree = dir("animePlayList", [
      dir("Re Zero", [file(S04E09, "h9", SIZE)]),
      file(S04E09, "h9", SIZE),
    ]);
    const db = libraryHolding(`Re Zero/${S04E09}`);
    const { scan, nextScanAt } = scanner(db, tree);
    await scan();

    // The recorded copy goes away; a download preallocated to the listed
    // copy's path has the right size but not yet the right bytes.
    take(tree, `Re Zero/${S04E09}`);
    take(tree, S04E09);
    place(tree, "", file(S04E09, "partial", SIZE, nextScanAt() - 1_000));
    const writing = await scan();

    expect(writing.deferredCount).toBe(1);
    expect(writing.newCount).toBe(0);
    expect(db.fileRefs.rows.size).toBe(1);
  });
});

describe("sorting files into folders", () => {
  test("a moved episode is relinked quietly, without dandanplay or a new-episode notice", async () => {
    const tree = dir("animePlayList", [dir("Re Zero", [])]);
    const db = libraryHolding(S04E09);
    const { scan, dandan } = scanner(db, tree);
    place(tree, "Re Zero", file(S04E09, "h9", SIZE));

    const moved = await scan();
    const after = await scan();

    expect(moved.newCount).toBe(0);
    expect(moved.relinkedCount).toBe(1);
    expect(after.relinkedCount).toBe(0);
    expect(db.fileRefs.rows.get(refOf("h9")).relPath).toBe(`Re Zero/${S04E09}`);
    expect(db.series.rows.get("sr-1").updatedAt).toBe(1);
    expect(dandan.calls).toHaveLength(0);
  });

  test("a genuinely new episode in the folder is still announced", async () => {
    const tree = dir("animePlayList", [dir("Re Zero", [file(S04E09, "h9", SIZE)])]);
    const db = libraryHolding(`Re Zero/${S04E09}`);
    const { scan } = scanner(db, tree);
    place(tree, "Re Zero", file("[Sub] Re Zero S04E10.mkv", "h10", SIZE + 1));

    const result = await scan();

    expect(result.newCount).toBe(1);
    const numbers = [...db.episodes.rows.values()].map((ep) => ep.number).sort((a, b) => a - b);
    expect(numbers).toEqual([9, 10]);
    expect(db.series.rows.get("sr-1").updatedAt).toBeGreaterThan(1);
  });
});

describe("more than one library folder", () => {
  test("moving a file inside one folder keeps it playable when another folder holds the old path", async () => {
    const roots = [
      { libraryId: "lib-A", tree: dir("A", [dir("Show", [file(S04E09, "h9", SIZE)])]) },
      { libraryId: "lib-B", tree: dir("B", [dir("Show", [file(S04E09, "h9", SIZE)])]) },
    ];
    const db = libraryHolding(`Show/${S04E09}`, { libraryId: "lib-A" });
    const { scan, dandan } = scanner(db, roots);
    await scan();

    place(roots[0].tree, "Show/Season 4", take(roots[0].tree, `Show/${S04E09}`));
    const results = [await scan(), await scan(), await scan()];

    for (const r of results) expect(r.newCount).toBe(0);
    expect(results[2].relinkedCount).toBe(0);
    const row = db.fileRefs.rows.get(refOf("h9"));
    expect(playable(roots, row.libraryId, row.relPath)).toBe(true);
    expect(dandan.calls).toHaveLength(0);
  });

  test("a show folder moved to another library folder, same path inside it, is relinked there", async () => {
    const roots = [
      { libraryId: "lib-downloads", tree: dir("Downloads", [dir("Show", [file(S04E09, "h9", SIZE)])]) },
      { libraryId: "lib-anime", tree: dir("Anime", []) },
    ];
    const db = libraryHolding(`Show/${S04E09}`, { libraryId: "lib-downloads" });
    const { scan, dandan } = scanner(db, roots);
    await scan();

    place(roots[1].tree, "Show", take(roots[0].tree, `Show/${S04E09}`));
    const moved = await scan();
    const after = await scan();

    const row = db.fileRefs.rows.get(refOf("h9"));
    expect(row.libraryId).toBe("lib-anime");
    expect(row.relPath).toBe(`Show/${S04E09}`);
    expect(moved.newCount).toBe(0);
    expect(moved.relinkedCount).toBe(1);
    expect(after.relinkedCount).toBe(0);
    expect(dandan.calls).toHaveLength(0);
  });

  test("while the original is still in place, the same path in another folder is left alone", async () => {
    const roots = [
      { libraryId: "lib-A", tree: dir("A", [dir("Show", [file(S04E09, "h9", SIZE)])]) },
      { libraryId: "lib-B", tree: dir("B", [dir("Show", [file(S04E09, "h9", SIZE)])]) },
    ];
    const db = libraryHolding(`Show/${S04E09}`, { libraryId: "lib-A" });
    const { scan } = scanner(db, roots);

    const results = [await scan(), await scan()];

    expect(results.map((r) => r.relinkedCount)).toEqual([0, 0]);
    expect(db.fileRefs.rows.get(refOf("h9")).libraryId).toBe("lib-A");
  });

  test("different files at the same path in two folders do not keep unseating each other", async () => {
    const E01 = "[Sub] Show E01.mkv";
    const roots = [
      { libraryId: "lib-A", tree: dir("A", [file(E01, "a1", SIZE, OLD)]) },
      { libraryId: "lib-B", tree: dir("B", []) },
    ];
    const db = libraryHolding(E01, { content: "a1", number: 1, libraryId: "lib-A" });
    const { scan } = scanner(db, roots);
    await scan();

    place(roots[1].tree, "", file(E01, "b1", SIZE + 1, OLD));
    const first = await scan();
    const later = [await scan(), await scan(), await scan()];

    expect(first.newCount).toBe(1);
    for (const r of later) {
      expect(r.newCount).toBe(0);
      expect(r.relinkedCount).toBe(0);
    }
    expect(db.fileRefs.rows.get(refOf("a1")).supersededAt).toBeUndefined();
    expect(db.fileRefs.rows.get(refOf("b1", SIZE + 1)).supersededAt).toBeUndefined();
  });
});
