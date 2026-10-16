import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";
import { fileRefId } from "../recordFactory.js";
import { memoryDb } from "./memoryDb.js";

// The import hashes files as their clusters come up, not the whole batch
// first. Before, a few hundred files on an external drive kept the library
// empty until the last one was read, and only then were the matches asked.

/** A file of one show, before hashing: what the folder scan hands the import. */
function episode(show, n) {
  const fileName = `[Sub] ${show} - ${String(n).padStart(2, "0")}.mkv`;
  return {
    fileId: `${fileName}|500|0`,
    file: { name: fileName, size: 500, lastModified: 0 },
    fileName,
    relativePath: `${show}/${fileName}`,
    episode: n,
    parsedKind: "main",
    parsedTitle: show,
    subtitle: null,
  };
}

// Clusters run largest first, so Frieren's three files come before Dandadan's two.
const FRIEREN = [1, 2, 3].map((n) => episode("Frieren", n));
const DANDADAN = [1, 2].map((n) => episode("Dandadan", n));
const ITEMS = [...DANDADAN, ...FRIEREN];

const hashOf = (fileName) => `h:${fileName}`;

const ANSWERS = new Map([
  ...FRIEREN.map((it) => [hashOf(it.fileName), 154587]),
  ...DANDADAN.map((it) => [hashOf(it.fileName), 171018]),
]);

/** dandanplay naming each file's show by its hash. */
const dandan = {
  match: async (hash) => {
    const anilistId = ANSWERS.get(hash);
    if (!anilistId) return null;
    return {
      isMatched: true,
      animes: [{ animeId: 0, animeTitle: String(anilistId) }],
      enrichment: { titleZh: String(anilistId) },
      anilistId,
    };
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** Hashes every file at once, except Dandadan's, which wait for `gate`. */
function gatedHasher(gate) {
  return async (file) => {
    if (file.name.includes("Dandadan")) return (await gate.promise) ?? hashOf(file.name);
    return hashOf(file.name);
  };
}

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

/** What the library holds, without the ids minted per import. */
function contents(db) {
  return [...db.episodes.rows.values()]
    .map((ep) => {
      const ref = db.fileRefs.rows.get(ep.primaryFileId);
      return `${db.series.rows.get(ep.seriesId)?.anilistId} #${ep.number} ${ref?.relPath} ${ref?.id} ${ref?.hash16M}`;
    })
    .sort();
}

const bindings = (db) => [...db.series.rows.values()].map((s) => s.anilistId).sort();

describe("hashing as the clusters come up", () => {
  test("★ the first show gets its card while a later show's files are still being read", async () => {
    const db = memoryDb({});
    const gate = deferred();
    const events = [];
    const run = runImport(
      { items: ITEMS, libraryId: "lib-1" },
      { db, dandan, hashFile: gatedHasher(gate), onEvent: (e) => events.push(e) },
    );

    await until(() => events.some((e) => e.kind === "clusterDone"));
    expect(bindings(db)).toEqual([154587]);

    gate.resolve();
    await run;
    expect(bindings(db)).toEqual([154587, 171018]);
  });

  test("files everything just as an import of hashes taken up front", async () => {
    const upFront = memoryDb({});
    await runImport(
      { items: ITEMS.map((it) => ({ ...it, hash16M: hashOf(it.fileName) })), libraryId: "lib-1" },
      { db: upFront, dandan },
    );

    const asItGoes = memoryDb({});
    const gate = deferred();
    gate.resolve();
    await runImport(
      { items: ITEMS, libraryId: "lib-1" },
      { db: asItGoes, dandan, hashFile: gatedHasher(gate) },
    );

    expect(contents(asItGoes)).toEqual(contents(upFront));
    expect(contents(asItGoes)).toHaveLength(5);
    const ref = asItGoes.fileRefs.rows.get(
      fileRefId({ ...FRIEREN[0], hash16M: hashOf(FRIEREN[0].fileName) }),
    );
    expect(ref?.hash16M).toBe(hashOf(FRIEREN[0].fileName));
  });

  test("a stop leaves the shows not yet imported for the next scan", async () => {
    const db = memoryDb({});
    let stopped = false;
    const summary = await runImport(
      { items: ITEMS, libraryId: "lib-1" },
      {
        db,
        dandan,
        hashFile: async (file) => hashOf(file.name),
        shouldStop: () => stopped,
        onEvent: (e) => {
          if (e.kind === "clusterDone") stopped = true;
        },
      },
    );
    expect(bindings(db)).toEqual([154587]);
    expect(summary.clusters).toBe(1);
    expect(db.fileRefs.rows.size).toBe(3);
  });

  test("★ a show whose files were still being read when the import stopped is not imported", async () => {
    // Stopping aborts the reads, so the files waiting come back without a
    // hash; imported anyway, they would take name-and-size ids.
    const db = memoryDb({});
    const gate = deferred();
    const events = [];
    let stopped = false;
    const run = runImport(
      { items: ITEMS, libraryId: "lib-1" },
      {
        db,
        dandan,
        hashFile: gatedHasher(gate),
        shouldStop: () => stopped,
        onEvent: (e) => events.push(e),
      },
    );

    await until(() => events.some((e) => e.kind === "clusterDone"));
    stopped = true;
    gate.resolve("");
    await run;

    expect(bindings(db)).toEqual([154587]);
    expect(db.fileRefs.rows.size).toBe(3);
  });
});
