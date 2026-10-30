import { describe, expect, test } from "bun:test";

import zhSpa from "@/locales/zh-spa.js";
import enSpa from "@/locales/en-spa.js";
import zhHantSpa from "@/locales/zh-Hant-spa.js";
import zh from "@/locales/zh";
import en from "@/locales/en";
import zhHant from "@/locales/zh-Hant";
import { LANGS } from "@/lib/i18n/lang";
import { USER_ACTION_ERROR_KEYS, userActionErrorKey, type UserAction } from "./adminUserErrors";

// What the drawer and the create form say for each answer go-api gives the
// admin user actions (go-api/internal/admin/users.go, user_sessions.go,
// and the auth middleware in front of them).

describe("go-api's answers, in the page's own words", () => {
  test("a taken username or email: one 409, told apart by go-api's message", () => {
    for (const action of ["create", "update"] as const) {
      expect(userActionErrorKey(action, { status: 409, message: "Username already exists" })).toBe(
        "admin.userPanel.errUsernameTaken",
      );
      expect(userActionErrorKey(action, { status: 409, message: "Email already exists" })).toBe(
        "admin.userPanel.errEmailTaken",
      );
    }
  });

  test("your own account: deleting it, or signing it out here", () => {
    expect(userActionErrorKey("delete", { status: 400, message: "Cannot delete yourself" })).toBe(
      "admin.userPanel.errSelfDelete",
    );
    for (const action of ["revokeAll", "revokeOne"] as const) {
      expect(userActionErrorKey(action, { status: 400, message: "Cannot sign yourself out here" })).toBe(
        "admin.userPanel.errSelfRevoke",
      );
    }
  });

  test("gone: the account, or for one device the session", () => {
    for (const action of ["update", "password", "delete", "revokeAll", "revokeOne"] as const) {
      expect(userActionErrorKey(action, { status: 404, message: "User not found" })).toBe(
        "admin.userPanel.detailMissing",
      );
    }
    expect(userActionErrorKey("revokeOne", { status: 404, message: "Session not found" })).toBe(
      "admin.userPanel.errSessionGone",
    );
  });

  test("a 404 with a message it does not know is the account only where nothing else can be gone", () => {
    expect(userActionErrorKey("revokeAll", { status: 404, message: "Something new" })).toBe(
      "admin.userPanel.detailMissing",
    );
    expect(userActionErrorKey("revokeOne", { status: 404, message: "Something new" })).toBe(
      "admin.userPanel.revokeFailed",
    );
  });

  test("the auth middleware: signed out, or not an admin, whatever the message", () => {
    const actions: UserAction[] = ["create", "update", "password", "delete", "revokeAll", "revokeOne"];
    for (const action of actions) {
      expect(userActionErrorKey(action, { status: 401, message: "Authentication required" })).toBe(
        "admin.userPanel.errSignedOut",
      );
      expect(userActionErrorKey(action, { status: 403, message: "Forbidden" })).toBe("admin.userPanel.errForbidden");
    }
  });

  test("anything else is the action's own failure: a 500, the network, a thrown action, our own checks", () => {
    expect(userActionErrorKey("create", { status: 500, message: "create user failed" })).toBe("admin.createFailed");
    expect(userActionErrorKey("update", { status: 0, message: "fetch failed" })).toBe("admin.updateFailed");
    expect(userActionErrorKey("password", { status: 0 })).toBe("admin.passwordChangeFailed");
    expect(userActionErrorKey("delete", { status: 400, message: "Invalid user ID" })).toBe("admin.deleteFailed");
    expect(userActionErrorKey("revokeAll", { status: 400, message: "缺少用户 ID" })).toBe(
      "admin.userPanel.revokeFailed",
    );
  });

  test("never the message itself, and never a key inherited from Object", () => {
    for (const message of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(userActionErrorKey("update", { status: 409, message })).toBe("admin.updateFailed");
    }
  });
});

// The keys are looked up at run time, which the dictionary coverage test
// (it reads t("…") literals) cannot see: every one is checked here. The
// dictionaries are imported directly rather than through @/lib/i18n, which
// another suite in this process replaces with a stub.
describe("every key it can answer is in the dictionaries", () => {
  const spa: Record<string, unknown> = { zh: zhSpa, en: enSpa, "zh-Hant": zhHantSpa };
  const server: Record<string, unknown> = { zh, en, "zh-Hant": zhHant };
  const resolve = (dict: unknown, key: string) =>
    key.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), dict);

  for (const lang of LANGS) {
    test(lang, () => {
      for (const key of USER_ACTION_ERROR_KEYS) {
        // What the page renders: the client dictionaries.
        expect(typeof resolve(spa[lang], key), `${lang} spa: ${key}`).toBe("string");
        // The words added for these failures are in the server ones too.
        if (key.startsWith("admin.userPanel.err")) {
          expect(typeof resolve(server[lang], key), `${lang} ts: ${key}`).toBe("string");
        }
      }
    });
  }
});
