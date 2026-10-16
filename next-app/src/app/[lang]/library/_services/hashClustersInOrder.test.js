import { describe, expect, spyOn, test } from "bun:test";
import { hashClustersInOrder } from "./hashClustersInOrder.js";

function item(name, overrides = {}) {
  return {
    fileId: `${name}|100|0`,
    file: { name, size: 100, lastModified: 0 },
    fileName: name,
    relativePath: `Show/${name}`,
    episode: 1,
    parsedKind: "main",
    ...overrides,
  };
}

function cluster(key, groups) {
  const items = groups.flat();
  return {
    clusterKey: key,
    normalizedTokens: [key],
    groups: groups.map((groupItems, i) => ({ id: `g${i}`, groupKey: `${key}/${i}`, items: groupItems })),
    items,
    representative: items[0],
  };
}

/** A hasher that answers each file only when the test lets it. */
function heldHasher() {
  const asked = [];
  const held = new Map();
  return {
    asked,
    hashFile: (file) =>
      new Promise((resolve, reject) => {
        asked.push(file.name);
        held.set(file.name, { resolve, reject });
      }),
    answer: (name, hash = `h-${name}`) => held.get(name).resolve(hash),
    fail: (name) => held.get(name).reject(new Error("unreadable")),
  };
}

const settled = (promise) =>
  Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), 10))]);

describe("hashClustersInOrder", () => {
  test("every file is queued at once, cluster by cluster in import order", () => {
    const hasher = heldHasher();
    hashClustersInOrder(
      [cluster("a", [[item("a1"), item("a2")]]), cluster("b", [[item("b1")]])],
      hasher.hashFile,
    );
    expect(hasher.asked).toEqual(["a1", "a2", "b1"]);
  });

  test("★ a cluster is ready once its own files are hashed, before later clusters' files", async () => {
    const hasher = heldHasher();
    const a = cluster("a", [[item("a1"), item("a2")]]);
    const b = cluster("b", [[item("b1")]]);
    const hashed = hashClustersInOrder([a, b], hasher.hashFile);

    const first = hashed(a);
    hasher.answer("a1");
    expect(await settled(first)).toBe(false);
    hasher.answer("a2");
    expect((await first).items.map((it) => it.hash16M)).toEqual(["h-a1", "h-a2"]);

    const second = hashed(b);
    expect(await settled(second)).toBe(false);
    hasher.answer("b1");
    expect((await second).items[0].hash16M).toBe("h-b1");
  });

  test("the hashed cluster's groups and representative are its hashed items", async () => {
    const hasher = heldHasher();
    const c = cluster("a", [[item("a1")], [item("a2")]]);
    c.representative = c.items[1];
    const hashed = hashClustersInOrder([c], hasher.hashFile);
    hasher.answer("a1");
    hasher.answer("a2");
    const out = await hashed(c);

    expect(out.groups[0].items[0]).toBe(out.items[0]);
    expect(out.groups[1].items[0]).toBe(out.items[1]);
    expect(out.representative).toBe(out.items[1]);
    expect(out.clusterKey).toBe("a");
    // The clusters handed in are left as they were.
    expect(c.items[0].hash16M).toBeUndefined();
  });

  test("a file already hashed, or with no file to read, is not read again", async () => {
    const hasher = heldHasher();
    const known = item("k", { hash16M: "known" });
    const missing = item("m", { file: undefined });
    const c = cluster("a", [[known, missing]]);
    const out = await hashClustersInOrder([c], hasher.hashFile)(c);
    expect(hasher.asked).toEqual([]);
    expect(out.items).toEqual([known, missing]);
  });

  test("a file that cannot be hashed is imported without a hash", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const hasher = heldHasher();
    const c = cluster("a", [[item("empty"), item("broken"), item("ok")]]);
    const hashed = hashClustersInOrder([c], hasher.hashFile);
    hasher.answer("empty", "");
    hasher.fail("broken");
    hasher.answer("ok");
    const out = await hashed(c);
    expect(out.items.map((it) => it.hash16M)).toEqual([undefined, undefined, "h-ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("without a hasher the cluster is returned as it is", async () => {
    const c = cluster("a", [[item("a1")]]);
    expect(await hashClustersInOrder([c], undefined)(c)).toBe(c);
  });
});
