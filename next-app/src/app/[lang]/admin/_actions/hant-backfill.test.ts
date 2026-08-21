import {
  describe,
  expect,
  test,
  beforeEach,
  mock,
  afterAll,
} from "bun:test";

// Same module-mock shape as enrichment-queue.test.ts / users.test.ts — three
// files in this directory already share it, so a fourth is proven safe.

interface ApiMutateCall {
  path: string;
  method: string;
  body?: unknown;
}

const apiMutateCalls: ApiMutateCall[] = [];
let apiMutateImpl: (path: string, method: string, opts?: { body?: unknown }) => Promise<unknown> =
  async () => ({});

mock.module("@/lib/api", () => ({
  apiMutate: async (path: string, method: string, opts?: { body?: unknown }) => {
    apiMutateCalls.push({ path, method, body: opts?.body });
    return apiMutateImpl(path, method, opts);
  },
  ApiError: class extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));

const revalidatePathCalls: string[] = [];

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatePathCalls.push(path);
  },
}));

const { runHantBackfill } = await import("./hant-backfill");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  apiMutateCalls.length = 0;
  revalidatePathCalls.length = 0;
  apiMutateImpl = async () => ({});
});

describe("runHantBackfill", () => {
  test("POSTs /api/admin/hant/backfill and revalidates /admin", async () => {
    apiMutateImpl = async () => ({ enqueued: true, message: "queued 2 rows" });
    const out = await runHantBackfill();
    expect(out).toEqual({ enqueued: true, message: "queued 2 rows" });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/hant/backfill",
      method: "POST",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("passes go-api's refusal through instead of flattening it to a success", async () => {
    // enqueued:false is a 200 with a "no" in it — "already running" must reach
    // the operator, not be swallowed into a generic confirmation.
    apiMutateImpl = async () => ({ enqueued: false, message: "already running" });
    const out = await runHantBackfill();
    expect(out).toEqual({ enqueued: false, message: "already running" });
  });

  test("a failure throws and skips revalidation", async () => {
    apiMutateImpl = async () => {
      throw new Error("server angry");
    };
    let thrown: unknown;
    try {
      await runHantBackfill();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toBe("server angry");
    expect(revalidatePathCalls).toHaveLength(0);
  });
});
