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
const revalidateTagCalls: Array<{ tag: string; profile?: string }> = [];

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatePathCalls.push(path);
  },
  revalidateTag: (tag: string, profile?: string) => {
    revalidateTagCalls.push({ tag, profile });
  },
}));

const { createAdminUser, updateAdminUser, deleteAdminUser } = await import(
  "./users"
);
const { UserActionError } = await import("./_shared");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  apiMutateCalls.length = 0;
  revalidatePathCalls.length = 0;
  revalidateTagCalls.length = 0;
  apiMutateImpl = async () => ({});
});

describe("createAdminUser", () => {
  test("trims + POSTs to /api/admin/users with body", async () => {
    apiMutateImpl = async () => ({
      _id: "u1",
      username: "alice",
      email: "alice@example.com",
    });
    const out = await createAdminUser({
      username: "  alice  ",
      email: "  alice@example.com  ",
      password: "secret123",
    });
    expect(out).toMatchObject({ _id: "u1", username: "alice" });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/users",
      method: "POST",
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
      },
    });
    expect(revalidateTagCalls).toContainEqual({
      tag: "admin:users",
      profile: "max",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("rejects empty username before the network call", async () => {
    let thrown: unknown;
    try {
      await createAdminUser({
        username: "   ",
        email: "ok@example.com",
        password: "secret123",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
    expect((thrown as InstanceType<typeof UserActionError>).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(apiMutateCalls).toHaveLength(0);
    expect(revalidatePathCalls).toHaveLength(0);
  });

  test("rejects short username (< 3 chars)", async () => {
    let thrown: unknown;
    try {
      await createAdminUser({
        username: "ab",
        email: "ok@example.com",
        password: "secret123",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
    expect(apiMutateCalls).toHaveLength(0);
  });

  test("rejects malformed email", async () => {
    let thrown: unknown;
    try {
      await createAdminUser({
        username: "alice",
        email: "not-an-email",
        password: "secret123",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
    expect(apiMutateCalls).toHaveLength(0);
  });

  test("rejects short password (< 6 chars)", async () => {
    let thrown: unknown;
    try {
      await createAdminUser({
        username: "alice",
        email: "ok@example.com",
        password: "12345",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
    expect(apiMutateCalls).toHaveLength(0);
  });
});

describe("updateAdminUser", () => {
  test("PATCHes /api/admin/users/:id with the diff", async () => {
    apiMutateImpl = async () => ({
      _id: "u1",
      username: "renamed",
      email: "alice@example.com",
      role: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    await updateAdminUser("u1", { username: "renamed" });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/users/u1",
      method: "PATCH",
      body: { username: "renamed" },
    });
  });

  test("encodes user IDs that need it (UUIDs are safe; slashes would not be)", async () => {
    apiMutateImpl = async () => ({
      _id: "weird/id",
      username: "a",
      email: "a@b.cc",
      role: null,
      createdAt: "x",
    });
    await updateAdminUser("weird/id", { username: "abc" });
    expect(apiMutateCalls[0]?.path).toBe("/api/admin/users/weird%2Fid");
  });

  test("revalidates admin:users + user:profile:{id} + /admin", async () => {
    apiMutateImpl = async () => ({
      _id: "u1",
      username: "a",
      email: "a@b.cc",
      role: null,
      createdAt: "x",
    });
    await updateAdminUser("u1", { email: "new@example.com" });
    expect(revalidateTagCalls).toContainEqual({
      tag: "admin:users",
      profile: "max",
    });
    expect(revalidateTagCalls).toContainEqual({
      tag: "user:profile:u1",
      profile: "max",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("throws when patch is empty", async () => {
    let thrown: unknown;
    try {
      await updateAdminUser("u1", {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
    expect((thrown as InstanceType<typeof UserActionError>).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(apiMutateCalls).toHaveLength(0);
  });

  test("throws when userId is missing", async () => {
    let thrown: unknown;
    try {
      await updateAdminUser("", { username: "a" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
  });
});

describe("deleteAdminUser", () => {
  test("DELETEs /api/admin/users/:id with no body", async () => {
    apiMutateImpl = async () => ({ deleted: true, username: "alice" });
    const out = await deleteAdminUser("u1");
    expect(out).toMatchObject({ deleted: true, username: "alice" });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/users/u1",
      method: "DELETE",
    });
    expect(apiMutateCalls[0]?.body).toBeUndefined();
  });

  test("revalidates the same tags as update", async () => {
    apiMutateImpl = async () => ({ deleted: true, username: "alice" });
    await deleteAdminUser("u1");
    expect(revalidateTagCalls).toContainEqual({
      tag: "admin:users",
      profile: "max",
    });
    expect(revalidateTagCalls).toContainEqual({
      tag: "user:profile:u1",
      profile: "max",
    });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("throws when userId is missing, no network call made", async () => {
    let thrown: unknown;
    try {
      await deleteAdminUser("");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UserActionError);
    expect(apiMutateCalls).toHaveLength(0);
  });
});
