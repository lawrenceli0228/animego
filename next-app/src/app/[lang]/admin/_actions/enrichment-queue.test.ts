import {
  describe,
  expect,
  test,
  beforeEach,
  mock,
  afterAll,
} from "bun:test";

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

const {
  pauseHealCn,
  resumeHealCn,
  healCn,
  reEnrich,
} = await import("./enrichment-queue");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  apiMutateCalls.length = 0;
  revalidatePathCalls.length = 0;
  apiMutateImpl = async () => ({});
});

describe("pauseHealCn", () => {
  test("POSTs /heal-cn/pause, revalidates /admin", async () => {
    apiMutateImpl = async () => ({ paused: true });
    const out = await pauseHealCn();
    expect(out).toEqual({ paused: true });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/enrichment/heal-cn/pause",
      method: "POST",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });
});

describe("resumeHealCn", () => {
  test("POSTs /heal-cn/resume, revalidates /admin", async () => {
    apiMutateImpl = async () => ({ paused: false });
    const out = await resumeHealCn();
    expect(out).toEqual({ paused: false });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/enrichment/heal-cn/resume",
      method: "POST",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });
});

describe("healCn", () => {
  test("POSTs /heal-cn, returns enqueued count, revalidates", async () => {
    apiMutateImpl = async () => ({ enqueued: 32 });
    const out = await healCn();
    expect(out).toEqual({ enqueued: 32 });
    expect(apiMutateCalls[0]?.path).toBe("/api/admin/enrichment/heal-cn");
    expect(revalidatePathCalls).toContain("/admin");
  });
});

describe("reEnrich", () => {
  test("POSTs /re-enrich?version=N, threads through enqueued count", async () => {
    apiMutateImpl = async () => ({ enqueued: 160, version: 2 });
    const out = await reEnrich(2);
    expect(out).toEqual({ enqueued: 160, version: 2 });
    expect(apiMutateCalls[0]?.path).toBe(
      "/api/admin/enrichment/re-enrich?version=2",
    );
    expect(apiMutateCalls[0]?.method).toBe("POST");
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("works for v0 and v1 as well", async () => {
    apiMutateImpl = async () => ({ enqueued: 1, version: 0 });
    await reEnrich(0);
    expect(apiMutateCalls[0]?.path).toBe(
      "/api/admin/enrichment/re-enrich?version=0",
    );
  });
});

describe("error propagation", () => {
  test("any action that fails throws and skips revalidation", async () => {
    apiMutateImpl = async () => {
      throw new Error("server angry");
    };
    let thrown: unknown;
    try {
      await pauseHealCn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(revalidatePathCalls).toHaveLength(0);
  });
});
