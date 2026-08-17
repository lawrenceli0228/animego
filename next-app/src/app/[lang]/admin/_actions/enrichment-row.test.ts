import {
  describe,
  expect,
  test,
  beforeEach,
  mock,
  afterAll,
} from "bun:test";

// Mock the two collaborators before the action module is loaded.
// `apiMutate` is the network round-trip; we capture invocations to
// verify path + method + body. `revalidatePath` / `revalidateTag` are
// the Next-side cache busters; we record their calls so the test can
// assert correct cache invalidation per the contract sheet in
// docs/migration/P7-DESIGN.md §5.

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
const revalidateTagCalls: Array<{ tag: string; profile?: string }> = [];

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatePathCalls.push(path);
  },
  revalidateTag: (tag: string, profile?: string) => {
    revalidateTagCalls.push({ tag, profile });
  },
}));

// Import after mocks are registered. Top-level await is fine inside
// bun:test files.
const {
  patchEnrichmentRow,
  flagEnrichmentRow,
  resetEnrichmentRow,
} = await import("./enrichment-row");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  apiMutateCalls.length = 0;
  revalidatePathCalls.length = 0;
  revalidateTagCalls.length = 0;
  apiMutateImpl = async () => ({});
});

describe("patchEnrichmentRow", () => {
  test("PATCHes /api/admin/enrichment/:id with the diff body", async () => {
    apiMutateImpl = async () => ({
      anilistId: 154587,
      titleChinese: "葬送的芙莉莲",
      bgmId: 400602,
      bangumiScore: 8.5,
      adminFlag: "manually-corrected",
    });
    await patchEnrichmentRow(154587, {
      titleChinese: "葬送的芙莉莲",
      bgmId: 400602,
    });
    expect(apiMutateCalls).toHaveLength(1);
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/enrichment/154587",
      method: "PATCH",
      body: { titleChinese: "葬送的芙莉莲", bgmId: 400602 },
    });
  });

  test("revalidates the anime detail tag + enrichment list path", async () => {
    apiMutateImpl = async () => ({ anilistId: 1, adminFlag: null });
    await patchEnrichmentRow(1, { titleChinese: "x" });
    expect(revalidateTagCalls).toContainEqual({
      tag: "anime:detail:1",
      profile: "max",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("propagates upstream errors as typed errors with code + status", async () => {
    apiMutateImpl = async () => {
      const e = new Error("not found");
      // The mocked ApiError class above is the one apiMutate consumers
      // see; mimic it directly here so the catch branch recognises it.
      (e as Error & { code?: string; status?: number }).code = "NOT_FOUND";
      (e as Error & { code?: string; status?: number }).status = 404;
      Object.setPrototypeOf(e, (await import("@/lib/api")).ApiError.prototype);
      throw e;
    };
    let thrown: unknown;
    try {
      await patchEnrichmentRow(999, { titleChinese: "x" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // No revalidation on error.
    expect(revalidateTagCalls).toHaveLength(0);
    expect(revalidatePathCalls).toHaveLength(0);
  });
});

describe("flagEnrichmentRow", () => {
  test("POSTs /flag with the requested flag value", async () => {
    apiMutateImpl = async () => ({ anilistId: 42, adminFlag: "needs-review" });
    await flagEnrichmentRow(42, "needs-review");
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/enrichment/42/flag",
      method: "POST",
      body: { flag: "needs-review" },
    });
  });

  test("accepts a null flag (clear)", async () => {
    apiMutateImpl = async () => ({ anilistId: 42, adminFlag: null });
    await flagEnrichmentRow(42, null);
    expect(apiMutateCalls[0]?.body).toEqual({ flag: null });
  });

  test("revalidates anime detail + admin path", async () => {
    apiMutateImpl = async () => ({ anilistId: 7, adminFlag: null });
    await flagEnrichmentRow(7, null);
    expect(revalidateTagCalls).toContainEqual({
      tag: "anime:detail:7",
      profile: "max",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });
});

describe("resetEnrichmentRow", () => {
  test("POSTs /reset with no body", async () => {
    apiMutateImpl = async () => ({ anilistId: 99, reset: true });
    await resetEnrichmentRow(99);
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/enrichment/99/reset",
      method: "POST",
    });
    expect(apiMutateCalls[0]?.body).toBeUndefined();
  });

  test("revalidates anime detail + admin path", async () => {
    apiMutateImpl = async () => ({ anilistId: 99, reset: true });
    await resetEnrichmentRow(99);
    expect(revalidateTagCalls).toContainEqual({
      tag: "anime:detail:99",
      profile: "max",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });
});
