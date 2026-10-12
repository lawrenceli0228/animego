import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";
import { baselineKey } from "@/app/[lang]/library/_services/rescanService.js";
import { fileRefId } from "../recordFactory.js";
import { memoryDb, recordingDandan } from "./memoryDb.js";

// A fileRef is keyed by content (hash of the first 16MB + size), so a file the
// library already holds keeps its row when it moves, gets renamed, or turns up
// a second time somewhere else. These tests pin what happens to that row.
//
// The bug they guard: a file with two copies on disk had one row naming one
// path. Each watch-folder scan found the other copy, imported it, and rewrote
// the row to that path — so the next scan found the first copy instead. The
// library announced "1 new episode" forever and asked dandanplay every time.

const SIZE = 900;
const RECORDED = "Re Zero/[Sub] Re Zero - 09.mkv";
const COPY = "[Sub] Re Zero - 09.mkv";
const MOVED = "Anime/Re Zero/[Sub] Re Zero - 09.mkv";

function item(relativePath, overrides = {}) {
  const fileName = relativePath.split("/").pop();
  return {
    fileId: `${fileName}|${SIZE}|1000`,
    file: { size: SIZE, lastModified: 1_000 },
    fileName,
    relativePath,
    episode: 9,
    parsedKind: "main",
    parsedTitle: "Re Zero",
    hash16M: "h9",
    subtitle: null,
    ...overrides,
  };
}

const REF = fileRefId(item(RECORDED));

/** What one library folder holds right now, as the rescan reports it. */
const onDiskIn = (libraryId, ...paths) =>
  new Map([[libraryId, new Set(paths.map((p) => baselineKey(p, SIZE)))]]);
const onDisk = (...paths) => onDiskIn("lib-1", ...paths);

/** A library that already holds episode 9 of one series, at RECORDED. */
function heldLibrary({ row = {}, seed = {} } = {}) {
  return memoryDb({
    series: [{ id: "sr-1", titleZh: "Re Zero", createdAt: 1, updatedAt: 1 }],
    episodes: [
      {
        id: "ep-9",
        seriesId: "sr-1",
        number: 9,
        kind: "main",
        primaryFileId: REF,
        alternateFileIds: [],
        updatedAt: 1,
      },
    ],
    fileRefs: [
      {
        id: REF,
        libraryId: "lib-1",
        episodeId: "ep-9",
        relPath: RECORDED,
        size: SIZE,
        mtime: 1_000,
        hash16M: "h9",
        matchStatus: "matched",
        ...row,
      },
    ],
    ...seed,
  });
}

describe("a file the library already holds", () => {
  test("never reaches the match cache or dandanplay", async () => {
    const db = heldLibrary();
    let cacheReads = 0;
    const readCache = db.matchCache.get;
    db.matchCache.get = async (hash) => {
      cacheReads++;
      return readCache(hash);
    };
    const dandan = recordingDandan();

    const summary = await runImport(
      { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(RECORDED, COPY) },
      { db, dandan },
    );

    expect(summary.matched).toBe(1);
    expect(dandan.calls).toHaveLength(0);
    expect(cacheReads).toBe(0);
  });

  test("a second copy keeps the recorded path and is listed as a copy", async () => {
    const db = heldLibrary();

    await runImport(
      { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(RECORDED, COPY) },
      { db, dandan: recordingDandan() },
    );

    const row = db.fileRefs.rows.get(REF);
    expect(row.relPath).toBe(RECORDED);
    expect(row.copies).toEqual([{ libraryId: "lib-1", relPath: COPY }]);
    expect(row.episodeId).toBe("ep-9");
    // Nothing new to show: no episode written, card not bumped, nothing cached.
    expect(db.episodes.rows.size).toBe(1);
    expect(db.series.rows.get("sr-1").updatedAt).toBe(1);
    expect(db.matchCache.rows.size).toBe(0);
  });

  test("finding the same copy again does not list it twice", async () => {
    const db = heldLibrary();
    const input = { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(RECORDED, COPY) };

    await runImport(input, { db, dandan: recordingDandan() });
    await runImport(input, { db, dandan: recordingDandan() });

    expect(db.fileRefs.rows.get(REF).copies).toEqual([{ libraryId: "lib-1", relPath: COPY }]);
  });

  test("a moved file takes over the recorded path once the old one is gone", async () => {
    const db = heldLibrary();

    await runImport(
      {
        items: [item(MOVED, { file: { size: SIZE, lastModified: 2_000 } })],
        libraryId: "lib-2",
        onDisk: onDiskIn("lib-2", MOVED),
      },
      { db, dandan: recordingDandan() },
    );

    const row = db.fileRefs.rows.get(REF);
    expect(row.relPath).toBe(MOVED);
    expect(row.libraryId).toBe("lib-2");
    expect(row.mtime).toBe(2_000);
    expect(row.copies).toBeUndefined();
    expect(row.episodeId).toBe("ep-9");
    expect(row.matchStatus).toBe("matched");
    expect(db.episodes.rows.size).toBe(1);
    expect(db.series.rows.get("sr-1").updatedAt).toBe(1);
  });

  test("a renamed file whose new name parses to no episode stays on its episode", async () => {
    const db = heldLibrary();
    const renamed = "Re Zero/ReZero S4 2160p.mkv";

    await runImport(
      { items: [item(renamed, { episode: null })], libraryId: "lib-1", onDisk: onDisk(renamed) },
      { db, dandan: recordingDandan() },
    );

    expect(db.fileRefs.rows.get(REF).episodeId).toBe("ep-9");
    expect(db.fileRefs.rows.get(REF).relPath).toBe(renamed);
    expect(db.episodes.rows.size).toBe(1);
  });

  test("a listed copy that is no longer on disk is dropped the next time the row is written", async () => {
    const db = heldLibrary({
      row: { copies: [{ libraryId: "lib-1", relPath: "Old/[Sub] Re Zero - 09.mkv" }] },
    });

    await runImport(
      { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(RECORDED, COPY) },
      { db, dandan: recordingDandan() },
    );

    expect(db.fileRefs.rows.get(REF).copies).toEqual([{ libraryId: "lib-1", relPath: COPY }]);
  });

  test("a listed copy under a folder that was not read is kept", async () => {
    const elsewhere = { libraryId: "lib-unplugged", relPath: "Re Zero/[Sub] Re Zero - 09.mkv" };
    const db = heldLibrary({ row: { copies: [elsewhere] } });

    await runImport(
      { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(RECORDED, COPY) },
      { db, dandan: recordingDandan() },
    );

    expect(db.fileRefs.rows.get(REF).copies).toEqual([
      elsewhere,
      { libraryId: "lib-1", relPath: COPY },
    ]);
  });

  test("the same relative path in another library folder is a different place", async () => {
    // lib-1 was read and no longer holds the file; lib-2 holds the same path.
    const db = heldLibrary();

    await runImport(
      {
        items: [item(RECORDED)],
        libraryId: "lib-2",
        onDisk: new Map([
          ["lib-1", new Set()],
          ["lib-2", new Set([baselineKey(RECORDED, SIZE)])],
        ]),
      },
      { db, dandan: recordingDandan() },
    );

    const row = db.fileRefs.rows.get(REF);
    expect(row.libraryId).toBe("lib-2");
    expect(row.relPath).toBe(RECORDED);
    expect(row.copies).toBeUndefined();
  });

  test("when the recorded path is gone, the copy still on disk takes over and leaves the list", async () => {
    const db = heldLibrary({ row: { copies: [{ libraryId: "lib-1", relPath: COPY }] } });

    await runImport(
      { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(COPY) },
      { db, dandan: recordingDandan() },
    );

    const row = db.fileRefs.rows.get(REF);
    expect(row.relPath).toBe(COPY);
    expect(row.copies).toBeUndefined();
  });

  test("with no word on what is on disk, the batch is the only evidence and the path is replaced", async () => {
    const db = heldLibrary();

    await runImport({ items: [item(COPY)], libraryId: "lib-1" }, { db, dandan: recordingDandan() });

    const row = db.fileRefs.rows.get(REF);
    expect(row.relPath).toBe(COPY);
    expect(row.copies).toBeUndefined();
  });

  test("a new episode found beside a held file still lands and bumps the series", async () => {
    const db = heldLibrary({
      seed: {
        seasons: [{ id: "season-1", seriesId: "sr-1", animeId: 42, number: null }],
        matchCache: [
          { hash16M: "h9", verdict: { kind: "new", animeId: 42 }, updatedAt: Date.now() },
          { hash16M: "h10", verdict: { kind: "new", animeId: 42 }, updatedAt: Date.now() },
        ],
      },
    });
    const ep10 = "Anime/Re Zero/[Sub] Re Zero - 10.mkv";

    await runImport(
      {
        items: [
          item(MOVED),
          item(ep10, { episode: 10, hash16M: "h10", file: { size: 1_000, lastModified: 1_000 } }),
        ],
        libraryId: "lib-1",
        onDisk: new Map([["lib-1", new Set([baselineKey(MOVED, SIZE), baselineKey(ep10, 1_000)])]]),
      },
      { db, dandan: recordingDandan() },
    );

    const numbers = [...db.episodes.rows.values()].map((ep) => ep.number).sort((a, b) => a - b);
    expect(numbers).toEqual([9, 10]);
    expect(db.fileRefs.rows.get(REF).relPath).toBe(MOVED);
    expect(db.fileRefs.rows.get(REF).episodeId).toBe("ep-9");
    expect(db.series.rows.get("sr-1").updatedAt).toBeGreaterThan(1);
  });
});

describe("two copies in one batch", () => {
  test("in one cluster: imported once, the other recorded as a copy", async () => {
    // Same parsed title, so both folders land in one cluster.
    const db = memoryDb();
    const first = "Re Zero/[Sub] Re Zero - 09.mkv";
    const second = "[Sub] Re Zero - 09.mkv";

    const summary = await runImport(
      {
        items: [item(first), item(second)],
        libraryId: "lib-1",
        onDisk: onDisk(first, second),
      },
      { db, dandan: recordingDandan() },
    );

    expect(db.series.rows.size).toBe(1);
    expect(db.episodes.rows.size).toBe(1);
    expect(db.fileRefs.rows.size).toBe(1);
    const row = db.fileRefs.rows.get(REF);
    expect([row.relPath, ...row.copies.map((c) => c.relPath)].sort()).toEqual(
      [first, second].sort(),
    );
    expect(row.copies).toHaveLength(1);
    // One file in two folders is not two folders merged into a card.
    expect(summary.crossFolderMerges).toEqual([]);
  });

  test("a stray copy outside the show's folder joins the show instead of starting a card", async () => {
    // The folder's files take their title from the folder; the stray copy at
    // the root takes its own from the file name, so it clusters alone. It
    // comes first in the batch, which used to let it claim the episode.
    const db = memoryDb();
    const stray = "[Sub] Copies Smoke - 01.mkv";
    const inFolder = `Copies Show/${stray}`;
    const ep2 = "Copies Show/[Sub] Copies Smoke - 02.mkv";
    const one = (relativePath, parsedTitle) =>
      item(relativePath, { episode: 1, hash16M: "h1", parsedTitle });

    await runImport(
      {
        items: [
          one(stray, "Copies Smoke"),
          one(inFolder, "Copies Show"),
          item(ep2, {
            episode: 2,
            hash16M: "h2",
            parsedTitle: "Copies Show",
            file: { size: SIZE + 1, lastModified: 1_000 },
          }),
        ],
        libraryId: "lib-1",
        onDisk: new Map([
          ["lib-1", new Set([baselineKey(stray, SIZE), baselineKey(inFolder, SIZE), baselineKey(ep2, SIZE + 1)])],
        ]),
      },
      { db, dandan: recordingDandan() },
    );

    expect(db.series.rows.size).toBe(1);
    expect(db.episodes.rows.size).toBe(2);
    const row = db.fileRefs.rows.get(fileRefId(one(inFolder, "Copies Show")));
    expect(row.relPath).toBe(inFolder);
    expect(row.copies).toEqual([{ libraryId: "lib-1", relPath: stray }]);
  });

  test("files without a content hash are never taken for copies", async () => {
    const db = memoryDb();

    await runImport(
      {
        items: [
          item("A/[Sub] Re Zero - 09.mkv", { hash16M: undefined }),
          item("B/[Sub] Re Zero - 09.mkv", { hash16M: undefined }),
        ],
        libraryId: "lib-1",
      },
      { db, dandan: recordingDandan() },
    );

    // Same name and size is not proof of the same bytes, so no row may claim
    // the other path as a copy of itself.
    expect([...db.fileRefs.rows.values()].some((row) => row.copies)).toBe(false);
  });
});

describe("an unmatched file", () => {
  test("found a second time is listed as a copy instead of replacing the path", async () => {
    const db = heldLibrary({
      row: { episodeId: undefined, matchStatus: "ambiguous" },
      seed: {
        episodes: [],
        matchCache: [
          {
            hash16M: "h9",
            verdict: {
              kind: "ambiguous",
              candidates: [
                { animeId: 1, animeTitle: "A", score: 1 },
                { animeId: 2, animeTitle: "B", score: 1 },
              ],
            },
            updatedAt: Date.now(),
          },
        ],
      },
    });

    await runImport(
      { items: [item(COPY)], libraryId: "lib-1", onDisk: onDisk(RECORDED, COPY) },
      { db, dandan: recordingDandan() },
    );

    const row = db.fileRefs.rows.get(REF);
    expect(row.relPath).toBe(RECORDED);
    expect(row.copies).toEqual([{ libraryId: "lib-1", relPath: COPY }]);
    expect(row.matchStatus).toBe("ambiguous");
  });
});
