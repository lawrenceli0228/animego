import { describe, expect, test } from "bun:test";

import {
  alternateFileIdsOf,
  buildOtherVersions,
  episodeHoldingFile,
  type VersionEpisodeRow,
  type VersionFileRef,
} from "./otherVersions";

// ─── fixtures ───────────────────────────────────────────────────────────────

// The reported library: LoliHouse holds every episode's primary file, a
// ktnbytes folder holds a second release of all of them, and a GreenTea file at
// the root holds a third copy of episode 1. Before this module the last two
// were reachable from nowhere in the UI.
const KTN = "[WEBrip] Super no Ura de Yani Suu Futari S01 [ktnbytes]";

function ep(
  id: string,
  number: number,
  alternateFileIds: string[] = [],
  primaryFileId = `primary-${id}`,
): VersionEpisodeRow {
  return { id, number, kind: "main", seriesId: "S", primaryFileId, alternateFileIds };
}

function ref(id: string, relPath: string, extra: Partial<VersionFileRef> = {}): VersionFileRef {
  return { id, relPath, ...extra };
}

const ktn = (n: number) =>
  ref(`ktn-${n}`, `${KTN}/Super no Ura de Yani Suu Futari 2026 S01E0${n}-[1080p][WEBRIP][AV1.AAC].mkv`);
const greenTea = ref(
  "gt-1",
  "[Studio GreenTea] Super no Ura de Yani Suu Futari [01][WebRip][HEVC-10bit 1080p AAC][JPSC].mp4",
  { group: "Studio GreenTea" },
);

const identity = (rows: VersionEpisodeRow[]) =>
  new Map(rows.map((row) => [row.id, row.number as number]));

// ─── buildOtherVersions ─────────────────────────────────────────────────────

describe("buildOtherVersions", () => {
  test("★ every alternate is listed under the folder it came from", () => {
    const episodes = [ep("e1", 1, ["ktn-1", "gt-1"]), ep("e2", 2, ["ktn-2"])];
    const groups = buildOtherVersions(episodes, [ktn(1), ktn(2), greenTea], identity(episodes));

    const byLabel = new Map(groups.map((g) => [g.label, g]));
    expect([...byLabel.keys()].sort()).toEqual(["Studio GreenTea", KTN].sort());
    expect(byLabel.get(KTN)!.entries.map((e) => [e.number, e.fileRefId])).toEqual([
      [1, "ktn-1"],
      [2, "ktn-2"],
    ]);
    expect(byLabel.get("Studio GreenTea")!.entries.map((e) => e.fileRefId)).toEqual(["gt-1"]);
    expect(byLabel.get(KTN)!.entries[0].episode.id).toBe("e1");
  });

  test("an entry carries the number its episode's chip shows, not the one on disk", () => {
    // A continuously numbered sequel: stored 16, shown as 2.
    const episodes = [ep("e16", 16, ["ktn-1"])];
    const [group] = buildOtherVersions(episodes, [ktn(1)], new Map([["e16", 2]]));
    expect(group.entries[0].number).toBe(2);
    expect(group.entries[0].rawNumber).toBe(16);
  });

  test("a file at the root is labeled by its release group, or its own name without one", () => {
    const bare = ref("bare-1", "Some Show - 01.mkv");
    const episodes = [ep("e1", 1, ["gt-1", "bare-1"])];
    const labels = buildOtherVersions(episodes, [greenTea, bare], identity(episodes)).map(
      (g) => g.label,
    );
    expect(labels.sort()).toEqual(["Some Show - 01.mkv", "Studio GreenTea"].sort());
  });

  test("files that are gone, superseded, or another episode's primary are left out", () => {
    const episodes = [
      ep("e1", 1, ["ktn-1", "missing", "old", "primary-e2"]),
      ep("e2", 2),
    ];
    const refs = [
      ktn(1),
      ref("old", `${KTN}/old.mkv`, { supersededAt: 1 }),
      ref("primary-e2", "LoliHouse/02.mkv"),
    ];
    const groups = buildOtherVersions(episodes, refs, identity(episodes));
    expect(groups.flatMap((g) => g.entries.map((e) => e.fileRefId))).toEqual(["ktn-1"]);
  });

  test("a card with no alternates has no other versions", () => {
    const episodes = [ep("e1", 1), ep("e2", 2)];
    expect(buildOtherVersions(episodes, [], identity(episodes))).toEqual([]);
  });

  test("one file listed on two episodes appears once", () => {
    const episodes = [ep("e1", 1, ["ktn-1"]), ep("e1b", 1, ["ktn-1"])];
    const groups = buildOtherVersions(episodes, [ktn(1)], identity(episodes));
    expect(groups.flatMap((g) => g.entries)).toHaveLength(1);
  });

  test("groups and entries come out in a stable order whatever order the rows arrive in", () => {
    const episodes = [ep("e2", 2, ["ktn-2"]), ep("e1", 1, ["ktn-1", "gt-1"])];
    const refs = [greenTea, ktn(2), ktn(1)];
    const a = buildOtherVersions(episodes, refs, identity(episodes));
    const b = buildOtherVersions([...episodes].reverse(), [...refs].reverse(), identity(episodes));
    expect(b).toEqual(a);
    expect(a.find((g) => g.label === KTN)!.entries.map((e) => e.number)).toEqual([1, 2]);
  });
});

// ─── alternateFileIdsOf ─────────────────────────────────────────────────────

describe("alternateFileIdsOf", () => {
  test("collects each alternate id once", () => {
    const episodes = [ep("e1", 1, ["a", "b"]), ep("e2", 2, ["b", "c"]), ep("e3", 3)];
    expect(alternateFileIdsOf(episodes)).toEqual(["a", "b", "c"]);
  });
});

// ─── episodeHoldingFile ─────────────────────────────────────────────────────

describe("episodeHoldingFile", () => {
  const episodes = [ep("e1", 1, ["ktn-1"]), ep("e2", 2, ["ktn-2"])];

  test("finds the episode a version belongs to", () => {
    expect(episodeHoldingFile(episodes, "ktn-2")?.id).toBe("e2");
  });

  test("finds the episode by its primary file too", () => {
    expect(episodeHoldingFile(episodes, "primary-e1")?.id).toBe("e1");
  });

  test("a file no episode holds finds nothing", () => {
    expect(episodeHoldingFile(episodes, "nope")).toBeUndefined();
    expect(episodeHoldingFile(episodes, "")).toBeUndefined();
  });
});
