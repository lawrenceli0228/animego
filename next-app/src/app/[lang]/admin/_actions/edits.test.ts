import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// The module-mock shape the other action tests in this directory share.

interface ApiMutateCall {
  path: string;
  method: string;
  body?: unknown;
}

const apiMutateCalls: ApiMutateCall[] = [];
let apiMutateImpl: (path: string, method: string, opts?: { body?: unknown }) => Promise<unknown> = async () => ({});

class FakeApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

mock.module("@/lib/api", () => ({
  apiMutate: async (path: string, method: string, opts?: { body?: unknown }) => {
    apiMutateCalls.push({ path, method, body: opts?.body });
    return apiMutateImpl(path, method, opts);
  },
  ApiError: FakeApiError,
}));

const revalidated: string[] = [];
mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const { reviewEditSubmission } = await import("./edits");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  apiMutateCalls.length = 0;
  revalidated.length = 0;
  apiMutateImpl = async () => ({});
});

const ID = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const body = { decisions: [{ itemId: ITEM, accept: true }] };

describe("reviewEditSubmission", () => {
  test("forwards the decisions and makes an accepted page public in every locale", async () => {
    apiMutateImpl = async () => ({ id: ID, kind: "character", entityId: 184313, acceptedCount: 1, rejectedCount: 0 });
    const out = await reviewEditSubmission(ID, body);
    expect(out.ok).toBe(true);
    expect(apiMutateCalls).toEqual([{ path: `/api/admin/edits/${ID}/review`, method: "POST", body }]);
    expect(revalidated).toEqual([
      "/zh-Hans/character/184313",
      "/en/character/184313",
      "/zh-Hant/character/184313",
    ]);
  });

  test("a person's page, and nothing revalidated when nothing was accepted", async () => {
    apiMutateImpl = async () => ({ id: ID, kind: "person", entityId: 133507, acceptedCount: 1, rejectedCount: 0 });
    await reviewEditSubmission(ID, body);
    expect(revalidated).toContain("/zh-Hans/person/133507");

    revalidated.length = 0;
    apiMutateImpl = async () => ({ id: ID, kind: "person", entityId: 133507, acceptedCount: 0, rejectedCount: 1 });
    await reviewEditSubmission(ID, { decisions: [{ itemId: ITEM, accept: false, note: "no" }] });
    expect(revalidated).toEqual([]);
  });

  test("refuses what it should not forward", async () => {
    for (const [id, b] of [
      ["not-an-id", body],
      [ID, { decisions: [{ itemId: ITEM, accept: false }] }],
      [ID, { decisions: "all" }],
    ] as const) {
      expect(await reviewEditSubmission(id, b)).toEqual({ ok: false, status: 400, message: "" });
    }
    expect(apiMutateCalls).toHaveLength(0);
  });

  test("go-api's refusal comes back with its status", async () => {
    apiMutateImpl = async () => {
      throw new FakeApiError("CONFLICT", "This submission has already been reviewed", 409);
    };
    expect(await reviewEditSubmission(ID, body)).toEqual({
      ok: false,
      status: 409,
      message: "This submission has already been reviewed",
    });
    expect(revalidated).toEqual([]);
  });
});
