import { describe, expect, test } from "bun:test";
import { runImport } from "@/app/[lang]/library/_services/importPipeline.js";
import { memoryDb, recordingDandan } from "./memoryDb.js";

// The import asks /api/dandanplay/match about one representative file per
// cluster. When dandanplay has not indexed that file's hash, the keyword is
// the only thing go-api can search by — and until now the import sent none,
// so a release group's own name for a show ("[Judas] Nama-Anaru - S01E08")
// produced a card that never matched.

function item(overrides = {}) {
  return {
    fileId: "f|900|0",
    file: { size: 900, lastModified: 0 },
    fileName: "[Judas] Nama-Anaru - S01E08.mkv",
    relativePath: "[Judas] Nama-Anaru - S01E08.mkv",
    episode: 8,
    parsedKind: "main",
    parsedTitle: "Nama-Anaru",
    parsedSeason: 1,
    hash16M: "cafebabe",
    subtitle: null,
    ...overrides,
  };
}

describe("importPipeline — the match carries a keyword", () => {
  test("★ the representative's title is sent as the keyword", async () => {
    const db = memoryDb();
    const dandan = recordingDandan();

    await runImport({ items: [item()], libraryId: "lib-1" }, { db, dandan });

    expect(dandan.calls.length).toBeGreaterThan(0);
    for (const [, , opts] of dandan.calls) {
      expect(opts.keyword).toBe("Nama-Anaru");
    }
  });

  test("a later season is spelled out for go-api's season gate", async () => {
    const db = memoryDb();
    const dandan = recordingDandan();

    await runImport(
      {
        items: [
          item({
            fileName: "[Judas] Kusuriya - S03E08.mkv",
            relativePath: "[Judas] Kusuriya - S03E08.mkv",
            parsedTitle: "Kusuriya",
            parsedSeason: 3,
          }),
        ],
        libraryId: "lib-1",
      },
      { db, dandan },
    );

    expect(dandan.calls[0][2].keyword).toBe("Kusuriya Season 3");
  });

  test("the file size still rides along", async () => {
    const db = memoryDb();
    const dandan = recordingDandan();

    await runImport({ items: [item()], libraryId: "lib-1" }, { db, dandan });

    expect(dandan.calls[0][2].fileSize).toBe(900);
  });
});
