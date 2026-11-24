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

  /**
   * The error a worker raises when its script fails to load. Fired even on a
   * terminated worker: some mobile browsers still report the load that
   * terminate() interrupted.
   */
  fail() {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.onerror?.(event);
    return event;
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
    // Not sent, and no worker was started for it either.
    expect(workers).toEqual([]);
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

describe("hashPool starts workers only when a file needs one", () => {
  test("no worker is started until a file is hashed", () => {
    const { workers } = fakePool(4);
    expect(workers).toEqual([]);
  });

  test("one file starts one worker, not the whole pool", async () => {
    const { pool, workers } = fakePool(4);
    const a = pool.hash(file("A"));
    await tick();
    expect(workers.length).toBe(1);
    workers[0].reply("hA");
    expect(await a).toBe("hA");
  });

  test("never starts more workers than the pool size", async () => {
    const { pool, workers } = fakePool(2);
    const hashes = ["A", "B", "C", "D", "E"].map((name) => pool.hash(file(name)));
    await tick();
    expect(workers.length).toBe(2);
    // Each round, every worker answers for the file it was last sent; a worker
    // with nothing new has no handler, so its repeat answer is ignored.
    for (let round = 0; round < 3; round += 1) {
      for (const worker of workers) worker.reply(`h${worker.sent.at(-1)}`);
      await tick();
    }
    expect(workers.length).toBe(2);
    expect(await Promise.all(hashes)).toEqual(["hA", "hB", "hC", "hD", "hE"]);
  });

  test("dispose before any file starts no worker", async () => {
    const { pool, workers } = fakePool(4);
    pool.dispose();
    expect(await pool.hash(file("A"))).toBe("");
    expect(workers).toEqual([]);
  });
});

describe("hashPool when a worker fails", () => {
  test("a worker that fails while reading settles its file at once and gets no more files", async () => {
    const { pool, workers } = fakePool();
    const a = pool.hash(file("A")); // default 10 s timeout: must not be what settles it
    await tick();
    const event = workers[0].fail();
    expect(await a).toBe("");
    expect(event.defaultPrevented).toBe(true);
    expect(workers[0].terminated).toBe(true);

    const b = pool.hash(file("B"));
    await tick();
    workers.at(-1).reply("hB");
    expect(await b).toBe("hB");
    expect(workers[0].sent).toEqual(["A"]);
    expect(workers.at(-1).sent).toEqual(["B"]);
  });

  test("a worker that fails while idle is not handed the next file", async () => {
    const { pool, workers } = fakePool();
    const a = pool.hash(file("A"));
    await tick();
    workers[0].reply("hA");
    expect(await a).toBe("hA");

    const event = workers[0].fail();
    expect(event.defaultPrevented).toBe(true);

    const b = pool.hash(file("B"));
    await tick();
    workers.at(-1).reply("hB");
    expect(await b).toBe("hB");
    expect(workers[0].sent).toEqual(["A"]);
    expect(workers.length).toBe(2);
  });

  test("a failure with nothing queued starts no new worker", async () => {
    const { pool, workers } = fakePool(2);
    const a = pool.hash(file("A"));
    await tick();
    workers[0].reply("hA");
    await a;
    workers[0].fail();
    expect(workers.length).toBe(1);
  });

  test("★ files queued behind failing workers still settle", async () => {
    // A failed worker leaves the pool. Files already waiting would wait for
    // a release that never comes unless the pool starts a worker for them.
    const { pool, workers } = fakePool(2);
    const hashes = ["A", "B", "C", "D", "E"].map((name) => pool.hash(file(name)));
    await tick();
    workers[0].fail();
    workers[1].fail();
    await tick();
    for (const worker of workers.slice(2)) worker.fail();
    expect(await Promise.all(hashes)).toEqual(["", "", "", "", ""]);
  });

  test("a worker that replaced a timed-out one is covered too", async () => {
    const { pool, workers } = fakePool();
    expect(await pool.hash(file("A"), { timeoutMs: 5 })).toBe("");
    expect(workers.length).toBe(2); // the replacement

    const event = workers[1].fail();
    expect(event.defaultPrevented).toBe(true);
    expect(workers[1].terminated).toBe(true);

    const b = pool.hash(file("B"));
    await tick();
    workers.at(-1).reply("hB");
    expect(await b).toBe("hB");
    expect(workers[1].sent).toEqual([]);
  });

  test("an error after dispose is swallowed", async () => {
    const { pool, workers } = fakePool();
    pool.hash(file("A"), { timeoutMs: 5 });
    await tick();
    pool.dispose();
    const event = workers[0].fail();
    expect(event.defaultPrevented).toBe(true);
    expect(workers.length).toBe(1);
  });
});

describe("hashPool after failures in a row", () => {
  /** Hash one file on a fresh worker that fails, and wait for its result. */
  async function hashOnFailingWorker(pool, workers, name) {
    const result = pool.hash(file(name));
    await tick();
    workers.at(-1).fail();
    return result;
  }

  test("stops starting workers after three failures in a row", async () => {
    const { pool, workers } = fakePool();
    for (const name of ["A", "B", "C"]) {
      expect(await hashOnFailingWorker(pool, workers, name)).toBe("");
    }
    expect(workers.length).toBe(3);

    expect(await pool.hash(file("D"))).toBe("");
    expect(workers.length).toBe(3);
  });

  test("a worker that answers resets the count", async () => {
    const { pool, workers } = fakePool();
    await hashOnFailingWorker(pool, workers, "A");
    await hashOnFailingWorker(pool, workers, "B");

    const c = pool.hash(file("C"));
    await tick();
    workers.at(-1).reply("hC");
    expect(await c).toBe("hC");

    workers.at(-1).fail(); // the worker that answered, now idle
    await hashOnFailingWorker(pool, workers, "D");

    const e = pool.hash(file("E"));
    await tick();
    expect(workers.at(-1).sent).toEqual(["E"]);
    workers.at(-1).reply("hE");
    expect(await e).toBe("hE");
  });
});
