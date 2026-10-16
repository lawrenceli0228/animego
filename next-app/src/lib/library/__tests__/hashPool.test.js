import { describe, expect, test } from "bun:test";
import { createHashPool } from "../hashPool.js";

// A stand-in for the md5 worker that answers only when the test says so, the
// way a worker reading a slow drive answers late.
class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.sent = [];
    this.terminated = false;
  }

  postMessage(msg) {
    this.sent.push(msg.file.name);
  }

  terminate() {
    this.terminated = true;
  }

  /** A terminated worker never answers, as with a real Worker. */
  reply(hash) {
    if (!this.terminated) this.onmessage?.({ data: { hash } });
  }
}

function fakePool(poolSize = 1) {
  const workers = [];
  const pool = createHashPool({
    poolSize,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

const file = (name) => ({ name });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("hashPool", () => {
  test("files are sent to the worker in the order they were asked for", async () => {
    const { pool, workers } = fakePool();
    const a = pool.hash(file("A"));
    const b = pool.hash(file("B"));
    const c = pool.hash(file("C"));
    await tick();
    workers[0].reply("hA");
    await tick();
    workers[0].reply("hB");
    await tick();
    workers[0].reply("hC");
    expect(await Promise.all([a, b, c])).toEqual(["hA", "hB", "hC"]);
    expect(workers[0].sent).toEqual(["A", "B", "C"]);
  });

  test("★ a file that timed out does not hand its hash to the next file", async () => {
    // The worker was released while still reading A; B's handler then took
    // A's late answer as B's hash, and that worker stayed one file behind.
    const { pool, workers } = fakePool();
    expect(await pool.hash(file("A"), { timeoutMs: 5 })).toBe("");

    const b = pool.hash(file("B"));
    await tick();
    workers[0].reply("hA"); // A's answer arrives after its timeout
    workers.at(-1).reply("hB");

    expect(await b).toBe("hB");
    expect(workers[0].terminated).toBe(true);
    expect(workers.at(-1).sent).toEqual(["B"]);
  });

  test("dispose also ends a worker that replaced a timed-out one", async () => {
    const { pool, workers } = fakePool();
    await pool.hash(file("A"), { timeoutMs: 5 });
    pool.dispose();
    expect(workers.map((w) => w.terminated)).toEqual([true, true]);
  });

  test("an aborted request still waiting for a worker is never sent", async () => {
    const { pool, workers } = fakePool();
    const abort = new AbortController();
    const a = pool.hash(file("A"));
    const b = pool.hash(file("B"), { signal: abort.signal });
    abort.abort();
    expect(await b).toBe("");

    workers[0].reply("hA");
    expect(await a).toBe("hA");
    const c = pool.hash(file("C"));
    await tick();
    workers[0].reply("hC");
    expect(await c).toBe("hC");
    expect(workers[0].sent).toEqual(["A", "C"]);
  });

  test("a request whose signal already aborted is not sent", async () => {
    const { pool, workers } = fakePool();
    const abort = new AbortController();
    abort.abort();
    expect(await pool.hash(file("A"), { signal: abort.signal })).toBe("");
    expect(workers[0].sent).toEqual([]);
  });

  test("a file already being read finishes when its request is aborted", async () => {
    const { pool, workers } = fakePool();
    const abort = new AbortController();
    const a = pool.hash(file("A"), { signal: abort.signal });
    await tick();
    abort.abort();
    workers[0].reply("hA");
    expect(await a).toBe("hA");
  });
});
