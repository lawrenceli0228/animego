import {
  describe,
  expect,
  test,
  beforeEach,
  mock,
  afterAll,
} from "bun:test";
import type { Dict } from "@/lib/i18n";
import type { UserActionFailure, UserActionResult } from "./_shared";

interface ApiMutateCall {
  path: string;
  method: string;
  body?: unknown;
  /** apiMutate's `auth` option as passed: undefined means the default, authenticated. */
  auth?: boolean;
}

// Minimal static dict that satisfies the Dict shape users.ts reads.
// Mirrors the zh.admin.userActions keys so validation messages flow through,
// plus the two userPanel keys the session actions read.
const STATIC_DICT: Pick<Dict, "admin"> = {
  admin: {
    userActions: {
      usernameEmpty: "Username cannot be empty",
      usernameMinMax: "Username must be {{min}}-{{max}} chars",
      emailEmpty: "Email cannot be empty",
      emailInvalid: "Invalid email format",
      passwordEmpty: "Password cannot be empty",
      passwordMinLen: "Password must be at least {{len}} chars",
      missingUserId: "Missing user ID",
      noUpdateFields: "No fields to update",
    },
    userPanel: {
      invalidUserId: "Invalid user ID",
      invalidSessionId: "Invalid session ID",
    },
  } as unknown as Dict["admin"],
};

// No getLang stub: the module no longer exports one. users.ts resolves its
// validation messages through getDict(), which is all this needs to fake.
mock.module("@/lib/i18n", () => ({
  getDict: async () => STATIC_DICT as Dict,
  getDictByLang: () => STATIC_DICT as Dict,
}));

const apiMutateCalls: ApiMutateCall[] = [];
let apiMutateImpl: (path: string, method: string, opts?: { body?: unknown }) => Promise<unknown> =
  async () => ({});

mock.module("@/lib/api", () => ({
  apiMutate: async (path: string, method: string, opts?: { body?: unknown; auth?: boolean }) => {
    apiMutateCalls.push({ path, method, body: opts?.body, auth: opts?.auth });
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

const {
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  setAdminUserPassword,
  revokeAdminUserSessions,
  revokeAdminUserSession,
} = await import("./users");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  apiMutateCalls.length = 0;
  revalidatePathCalls.length = 0;
  revalidateTagCalls.length = 0;
  apiMutateImpl = async () => ({});
});

/** The failure an action answered with, so a test can read its status, code and message. */
function failureOf(result: UserActionResult<unknown>): UserActionFailure {
  expect(result.ok).toBe(false);
  return result as UserActionFailure;
}

/** Every action answers; none throws, whatever happened. */
async function answer<T>(run: () => Promise<UserActionResult<T>>): Promise<UserActionResult<T>> {
  let result: UserActionResult<T> | undefined;
  let thrown: unknown;
  try {
    result = await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeUndefined();
  return result as UserActionResult<T>;
}

/** go-api refusing: what apiMutate throws for a non-2xx answer. */
async function apiError(code: string, message: string, status: number): Promise<Error> {
  const { ApiError } = await import("@/lib/api");
  return new ApiError(code, message, status);
}

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
    expect(out).toMatchObject({ ok: true, data: { _id: "u1", username: "alice" } });
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

  test("refuses each bad field before the network, as a 400 with the dictionary's words", async () => {
    const cases: Array<[{ username: string; email: string; password: string }, string]> = [
      [{ username: "   ", email: "ok@example.com", password: "secret123" }, "Username cannot be empty"],
      [{ username: "ab", email: "ok@example.com", password: "secret123" }, "Username must be 3-50 chars"],
      [{ username: "alice", email: "   ", password: "secret123" }, "Email cannot be empty"],
      [{ username: "alice", email: "not-an-email", password: "secret123" }, "Invalid email format"],
      [{ username: "alice", email: "ok@example.com", password: "" }, "Password cannot be empty"],
      [{ username: "alice", email: "ok@example.com", password: "12345" }, "Password must be at least 6 chars"],
    ];
    for (const [input, message] of cases) {
      expect(failureOf(await answer(() => createAdminUser(input)))).toEqual({
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message,
      });
    }
    expect(apiMutateCalls).toHaveLength(0);
    expect(revalidatePathCalls).toHaveLength(0);
    expect(revalidateTagCalls).toHaveLength(0);
  });

  test("a username go-api says is taken comes back as its 409, with go-api's code and message", async () => {
    const err = await apiError("CONFLICT", "Username already exists", 409);
    apiMutateImpl = async () => {
      throw err;
    };
    const out = await answer(() =>
      createAdminUser({ username: "alice", email: "alice@example.com", password: "secret123" }),
    );
    expect(out).toEqual({ ok: false, status: 409, code: "CONFLICT", message: "Username already exists" });
    expect(revalidateTagCalls).toEqual([]);
    expect(revalidatePathCalls).toEqual([]);
  });
});

describe("updateAdminUser", () => {
  test("PATCHes /api/admin/users/:id with the diff and answers with the account", async () => {
    apiMutateImpl = async () => ({
      _id: "u1",
      username: "renamed",
      email: "alice@example.com",
      role: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const out = await updateAdminUser("u1", { username: "renamed" });
    expect(out).toMatchObject({ ok: true, data: { username: "renamed" } });
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

  test("refuses an empty patch, or a missing id, before the network", async () => {
    expect(failureOf(await answer(() => updateAdminUser("u1", {})))).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "No fields to update",
    });
    expect(failureOf(await answer(() => updateAdminUser("", { username: "abc" })))).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Missing user ID",
    });
    expect(apiMutateCalls).toHaveLength(0);
  });

  test("an account deleted meanwhile is go-api's 404, nothing revalidated", async () => {
    const err = await apiError("NOT_FOUND", "User not found", 404);
    apiMutateImpl = async () => {
      throw err;
    };
    const out = failureOf(await answer(() => updateAdminUser("u1", { username: "abc" })));
    expect(out).toMatchObject({ status: 404, code: "NOT_FOUND", message: "User not found" });
    expect(revalidateTagCalls).toEqual([]);
  });
});

describe("deleteAdminUser", () => {
  test("DELETEs /api/admin/users/:id with no body", async () => {
    apiMutateImpl = async () => ({ deleted: true, username: "alice" });
    const out = await deleteAdminUser("u1");
    expect(out).toEqual({ ok: true, data: { deleted: true, username: "alice" } });
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

  test("refuses a missing id, no network call made", async () => {
    expect(failureOf(await answer(() => deleteAdminUser("")))).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(apiMutateCalls).toHaveLength(0);
  });

  test("deleting yourself is go-api's 400, with its message", async () => {
    const err = await apiError("BAD_REQUEST", "Cannot delete yourself", 400);
    apiMutateImpl = async () => {
      throw err;
    };
    expect(await answer(() => deleteAdminUser("u1"))).toEqual({
      ok: false,
      status: 400,
      code: "BAD_REQUEST",
      message: "Cannot delete yourself",
    });
    expect(revalidatePathCalls).toEqual([]);
  });
});

describe("setAdminUserPassword", () => {
  test("POSTs password to /api/admin/users/:id/password", async () => {
    apiMutateImpl = async () => ({ success: true });
    const out = await setAdminUserPassword("u1", "newpassword");
    expect(out).toEqual({ ok: true, data: null });
    expect(apiMutateCalls[0]).toMatchObject({
      path: "/api/admin/users/u1/password",
      method: "POST",
      body: { password: "newpassword" },
    });
  });

  test("revalidates user:profile:{id} only (no admin:users)", async () => {
    apiMutateImpl = async () => ({ success: true });
    await setAdminUserPassword("u2", "newpassword");
    expect(revalidateTagCalls).toContainEqual({
      tag: "user:profile:u2",
      profile: "max",
    });
    // password change does not bust the user list
    expect(revalidateTagCalls.map((c) => c.tag)).not.toContain("admin:users");
  });

  test("encodes user ID in the path", async () => {
    apiMutateImpl = async () => ({ success: true });
    await setAdminUserPassword("weird/id", "pw123456");
    expect(apiMutateCalls[0]?.path).toBe(
      "/api/admin/users/weird%2Fid/password",
    );
  });

  test("refuses a missing id, or a short password, before the network", async () => {
    expect(failureOf(await answer(() => setAdminUserPassword("", "pw123456")))).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Missing user ID",
    });
    expect(failureOf(await answer(() => setAdminUserPassword("u1", "12345")))).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Password must be at least 6 chars",
    });
    expect(apiMutateCalls).toHaveLength(0);
  });
});

describe("what a failure carries back", () => {
  test("an unexpected error is logged on the server, and its message is not sent", async () => {
    // Not an ApiError: something inside the action itself, which can name
    // internals the browser has no business seeing.
    apiMutateImpl = async () => {
      throw new Error("database connection lost");
    };
    expect(await answer(() => deleteAdminUser("u1"))).toEqual({
      ok: false,
      status: 500,
      code: "UNEXPECTED",
      message: "",
    });
  });

  test("go-api out of reach is apiMutate's NETWORK_ERROR, status 0", async () => {
    const err = await apiError("NETWORK_ERROR", "fetch failed", 0);
    apiMutateImpl = async () => {
      throw err;
    };
    expect(failureOf(await answer(() => deleteAdminUser("u1")))).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });
});

// ─── The session actions ────────────────────────────────────────────────
//
// Synthetic ids. The user id is a uuid because go-api's users.id is one; so
// is the session id (user_sessions.id).

const USER_ID = "0a1b2c3d-0000-4000-8000-00000000000a";
const SESSION_ID = "0a1b2c3d-0000-4000-8000-0000000000b1";

describe("revokeAdminUserSessions", () => {
  test("DELETEs /api/admin/users/:id/sessions with no body and answers with go-api's count", async () => {
    apiMutateImpl = async () => ({ revoked: 3 });
    const out = await revokeAdminUserSessions(USER_ID);
    expect(out).toEqual({ ok: true, data: { revoked: 3 } });
    expect(apiMutateCalls).toEqual([
      { path: `/api/admin/users/${USER_ID}/sessions`, method: "DELETE", body: undefined, auth: undefined },
    ]);
  });

  test("goes out as the caller, so go-api re-checks the admin role on the request", async () => {
    apiMutateImpl = async () => ({ revoked: 0 });
    await revokeAdminUserSessions(USER_ID);
    // `auth: false` would make it anonymous; the default forwards the session.
    expect(apiMutateCalls[0]?.auth).not.toBe(false);
  });

  test("a refusal from go-api's admin check comes back with its status, and nothing is revalidated", async () => {
    const err = await apiError("FORBIDDEN", "Admin only", 403);
    apiMutateImpl = async () => {
      throw err;
    };
    const out = failureOf(await answer(() => revokeAdminUserSessions(USER_ID)));
    expect(out.code).toBe("FORBIDDEN");
    expect(out.status).toBe(403);
    expect(revalidateTagCalls).toEqual([]);
    expect(revalidatePathCalls).toEqual([]);
  });

  test("signing yourself out here is go-api's 400, with go-api's message", async () => {
    const err = await apiError("BAD_REQUEST", "Cannot sign yourself out here", 400);
    apiMutateImpl = async () => {
      throw err;
    };
    const out = failureOf(await answer(() => revokeAdminUserSessions(USER_ID)));
    expect(out.status).toBe(400);
    expect(out.message).toBe("Cannot sign yourself out here");
  });

  test("revalidates the list, the profile and /admin", async () => {
    apiMutateImpl = async () => ({ revoked: 1 });
    await revokeAdminUserSessions(USER_ID);
    expect(revalidateTagCalls).toContainEqual({ tag: "admin:users", profile: "max" });
    expect(revalidateTagCalls).toContainEqual({ tag: `user:profile:${USER_ID}`, profile: "max" });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("refuses a missing or non-uuid user id before the network", async () => {
    expect(failureOf(await answer(() => revokeAdminUserSessions(""))).message).toBe("Missing user ID");
    for (const bad of ["u1", "../users", `${USER_ID}/sessions`, `${USER_ID} `]) {
      const out = failureOf(await answer(() => revokeAdminUserSessions(bad)));
      expect(out.code).toBe("VALIDATION_ERROR");
      expect(out.message).toBe("Invalid user ID");
    }
    expect(apiMutateCalls).toHaveLength(0);
  });
});

describe("revokeAdminUserSession", () => {
  test("DELETEs /api/admin/users/:id/sessions/:sessionId with no body", async () => {
    apiMutateImpl = async () => ({ revoked: 1 });
    const out = await revokeAdminUserSession(USER_ID, SESSION_ID);
    expect(out).toEqual({ ok: true, data: { revoked: 1 } });
    expect(apiMutateCalls).toEqual([
      {
        path: `/api/admin/users/${USER_ID}/sessions/${SESSION_ID}`,
        method: "DELETE",
        body: undefined,
        auth: undefined,
      },
    ]);
    expect(revalidateTagCalls).toContainEqual({ tag: "admin:users", profile: "max" });
    expect(revalidatePathCalls).toContain("/admin");
  });

  test("another account's session is go-api's 404, nothing revalidated", async () => {
    const err = await apiError("NOT_FOUND", "Session not found", 404);
    apiMutateImpl = async () => {
      throw err;
    };
    const out = failureOf(await answer(() => revokeAdminUserSession(USER_ID, SESSION_ID)));
    expect(out.status).toBe(404);
    expect(out.message).toBe("Session not found");
    expect(revalidateTagCalls).toEqual([]);
  });

  test("an unauthenticated caller is go-api's 401", async () => {
    const err = await apiError("UNAUTHORIZED", "Not authenticated", 401);
    apiMutateImpl = async () => {
      throw err;
    };
    expect(failureOf(await answer(() => revokeAdminUserSession(USER_ID, SESSION_ID))).status).toBe(401);
  });

  test("refuses a bad session id, or a bad user id, before the network", async () => {
    for (const bad of ["", "s1", "../../users", `${SESSION_ID}?x=1`]) {
      const out = failureOf(await answer(() => revokeAdminUserSession(USER_ID, bad)));
      expect(out.code).toBe("VALIDATION_ERROR");
      expect(out.message).toBe("Invalid session ID");
    }
    expect(failureOf(await answer(() => revokeAdminUserSession("nope", SESSION_ID))).message).toBe("Invalid user ID");
    expect(apiMutateCalls).toHaveLength(0);
  });
});
