import { describe, expect, test } from "bun:test";

import { listSubtitlesNear, type DirLike, type FileLike } from "./listNearby";

type Tree = { [name: string]: string | Tree };

function file(name: string, body: string): FileLike {
  return { kind: "file", name, getFile: async () => new File([body], name) };
}

function dir(name: string, tree: Tree): DirLike {
  const entries = Object.entries(tree).map(([k, v]) => (typeof v === "string" ? file(k, v) : dir(k, v)));
  return {
    kind: "directory",
    name,
    async getDirectoryHandle(n) {
      const d = entries.find((e) => e.kind === "directory" && e.name === n);
      if (!d) throw Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
      return d as DirLike;
    },
    async *values() {
      yield* entries;
    },
  };
}

const root = dir("root", {
  "Show S1": {
    "Show - 01.mkv": "v",
    "Show - 01.sc.ass": "sc",
    "Show - 01.tc.ass": "tc",
    "cover.jpg": "x",
    Subs: { "Show - 01.chs.srt": "chs", "readme.txt": "x", deeper: { "Show - 01.ass": "too deep" } },
  },
  "Show S2": { "Show - 01.ass": "other season" },
  "top.ass": "root level",
});

const paths = (xs: { relPath: string }[]) => xs.map((x) => x.relPath).sort();

describe("listSubtitlesNear", () => {
  test("the video's folder and the folders directly inside it", async () => {
    expect(paths(await listSubtitlesNear(root, "Show S1/Show - 01.mkv"))).toEqual([
      "Show S1/Show - 01.sc.ass",
      "Show S1/Show - 01.tc.ass",
      "Show S1/Subs/Show - 01.chs.srt",
    ]);
  });

  test("a video at the root of the library: the root and its direct subfolders", async () => {
    expect(paths(await listSubtitlesNear(root, "top.mkv"))).toEqual([
      "Show S1/Show - 01.sc.ass",
      "Show S1/Show - 01.tc.ass",
      "Show S2/Show - 01.ass",
      "top.ass",
    ]);
  });

  test("a folder that is gone, or a path that climbs out, gives nothing", async () => {
    expect(await listSubtitlesNear(root, "Missing/ep.mkv")).toEqual([]);
    expect(await listSubtitlesNear(root, "../ep.mkv")).toEqual([]);
  });
});
