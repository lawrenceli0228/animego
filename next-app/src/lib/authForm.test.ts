import { describe, expect, test } from "bun:test";
import {
  extractServerMessage,
  sanitizeFromParam,
  translateErrorMessage,
} from "./authForm";

describe("sanitizeFromParam", () => {
  test("returns / when value is missing", () => {
    expect(sanitizeFromParam(undefined)).toBe("/");
  });

  test("returns / when value is empty or too short", () => {
    expect(sanitizeFromParam("")).toBe("/");
    expect(sanitizeFromParam("/")).toBe("/");
  });

  test("keeps a same-origin absolute path", () => {
    expect(sanitizeFromParam("/library")).toBe("/library");
    expect(sanitizeFromParam("/player?seriesId=abc&fileId=42")).toBe(
      "/player?seriesId=abc&fileId=42",
    );
    expect(sanitizeFromParam("/admin/users#section")).toBe("/admin/users#section");
  });

  test("rejects protocol-relative URLs", () => {
    expect(sanitizeFromParam("//evil.com/path")).toBe("/");
    expect(sanitizeFromParam("/\\evil.com")).toBe("/");
  });

  test("rejects fully-qualified URLs", () => {
    expect(sanitizeFromParam("https://evil.com/path")).toBe("/");
    expect(sanitizeFromParam("javascript:alert(1)")).toBe("/");
  });

  test("rejects paths whose second char is a control / whitespace byte", () => {
    // Clients that normalise tabs/nulls/newlines to "/" before navigating
    // would otherwise see "//evil.com" — the allowlist closes that gap.
    expect(sanitizeFromParam("/\tevil.com")).toBe("/");
    expect(sanitizeFromParam("/\nevil.com")).toBe("/");
    expect(sanitizeFromParam("/\0evil.com")).toBe("/");
    expect(sanitizeFromParam("/ evil.com")).toBe("/");
  });

  test("rejects paths whose second char is non-alphanumeric punctuation", () => {
    expect(sanitizeFromParam("/.well-known")).toBe("/");
    expect(sanitizeFromParam("/_next/data")).toBe("/");
    expect(sanitizeFromParam("/-foo")).toBe("/");
  });

  test("rejects /login to prevent redirect loop", () => {
    expect(sanitizeFromParam("/login")).toBe("/");
    expect(sanitizeFromParam("/login?from=%2Flibrary")).toBe("/");
    expect(sanitizeFromParam("/login#hash")).toBe("/");
  });

  test("rejects /register to prevent redirect loop", () => {
    // Same self-loop risk as /login — a stale tab on the register form
    // could otherwise round-trip the user back to the registration page
    // after a successful auth bypass.
    expect(sanitizeFromParam("/register")).toBe("/");
    expect(sanitizeFromParam("/register?from=%2Flibrary")).toBe("/");
    expect(sanitizeFromParam("/register#hash")).toBe("/");
  });

  test("self-loop check is boundary-aware: /register-prefix paths are allowed", () => {
    // Documents that the self-loop check only matches the exact route
    // plus ? / # suffixes — anything that just happens to start with
    // "/register" or "/login" is a different route and stays valid.
    expect(sanitizeFromParam("/registernew")).toBe("/registernew");
    expect(sanitizeFromParam("/register-success")).toBe("/register-success");
    expect(sanitizeFromParam("/logins/audit")).toBe("/logins/audit");
  });

  test("array input — takes the first entry", () => {
    expect(sanitizeFromParam(["/library", "/admin"])).toBe("/library");
  });
});

describe("extractServerMessage", () => {
  test("returns null for non-objects", () => {
    expect(extractServerMessage(null)).toBeNull();
    expect(extractServerMessage(undefined)).toBeNull();
    expect(extractServerMessage("string body")).toBeNull();
    expect(extractServerMessage(42)).toBeNull();
  });

  test("returns null when error key is missing or wrong shape", () => {
    expect(extractServerMessage({})).toBeNull();
    expect(extractServerMessage({ error: null })).toBeNull();
    expect(extractServerMessage({ error: "string-not-object" })).toBeNull();
    expect(extractServerMessage({ error: { code: "X" } })).toBeNull();
  });

  test("returns null when message is empty or not a string", () => {
    expect(extractServerMessage({ error: { message: "" } })).toBeNull();
    expect(extractServerMessage({ error: { message: 123 } })).toBeNull();
    expect(extractServerMessage({ error: { message: null } })).toBeNull();
  });

  test("returns the message string when present", () => {
    expect(
      extractServerMessage({
        error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码错误" },
      }),
    ).toBe("邮箱或密码错误");
    expect(
      extractServerMessage({
        error: { code: "DUPLICATE_ERROR", message: "用户名或邮箱已存在" },
      }),
    ).toBe("用户名或邮箱已存在");
  });
});

describe("translateErrorMessage", () => {
  test("returns mapped translation when key exists in dict.errors", () => {
    const dict = {
      errors: { "Invalid email or password": "邮箱或密码错误" },
    };
    expect(translateErrorMessage("Invalid email or password", dict)).toBe(
      "邮箱或密码错误",
    );
  });

  test("falls back to the raw message when key is missing", () => {
    const dict = { errors: { "Other error": "其他错误" } };
    expect(translateErrorMessage("Unmapped backend message", dict)).toBe(
      "Unmapped backend message",
    );
  });

  test("falls back to raw message when translation is empty string", () => {
    const dict = { errors: { "Empty translation": "" } };
    expect(translateErrorMessage("Empty translation", dict)).toBe(
      "Empty translation",
    );
  });

  test("caps result at 200 chars defensively", () => {
    const longMessage = "a".repeat(500);
    const dict = { errors: {} };
    expect(translateErrorMessage(longMessage, dict).length).toBe(200);
  });

  test("rejects inherited prototype keys (__proto__, constructor, toString)", () => {
    // Prototype-polluted lookup must not return a function or random
    // truthy value. hasOwnProperty guard means the lookup misses and
    // we fall through to the raw message.
    const dict = { errors: {} };
    expect(translateErrorMessage("__proto__", dict)).toBe("__proto__");
    expect(translateErrorMessage("constructor", dict)).toBe("constructor");
    expect(translateErrorMessage("toString", dict)).toBe("toString");
    expect(translateErrorMessage("hasOwnProperty", dict)).toBe("hasOwnProperty");
  });

  test("an own-property override of toString is honoured (not blocked by name)", () => {
    // The guard is about prototype keys, not about the name "toString"
    // itself. If someone really maps that key, we use the translation.
    const dict = { errors: { toString: "翻译版" } };
    expect(translateErrorMessage("toString", dict)).toBe("翻译版");
  });
});
