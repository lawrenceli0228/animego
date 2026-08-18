import { describe, expect, test } from "bun:test";

import {
  PASSWORD_MIN_LENGTH,
  isConfirmMismatchVisible,
  validateRegisterFields,
} from "./registerValidation";

describe("validateRegisterFields", () => {
  test("accepts a long-enough password that matches its confirmation", () => {
    expect(validateRegisterFields("hunter22", "hunter22")).toBeNull();
  });

  test("rejects a password below the minimum length", () => {
    expect(validateRegisterFields("abc", "abc")).toBe("pwdTooShort");
  });

  test("accepts a password exactly at the minimum length", () => {
    const exact = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(validateRegisterFields(exact, exact)).toBeNull();
  });

  test("rejects one character below the minimum", () => {
    const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(validateRegisterFields(short, short)).toBe("pwdTooShort");
  });

  test("rejects a mismatched confirmation", () => {
    expect(validateRegisterFields("hunter22", "hunter23")).toBe("pwdMismatch");
  });

  test("rejects an empty confirmation even when the password is valid", () => {
    expect(validateRegisterFields("hunter22", "")).toBe("pwdMismatch");
  });

  // Order matters: "abc"/"abd" is both too short AND mismatched. Reporting the
  // mismatch first would send the user to fix the confirm box, only to be told
  // on the next submit that the password was never long enough.
  test("reports length before mismatch when both are wrong", () => {
    expect(validateRegisterFields("abc", "abd")).toBe("pwdTooShort");
  });

  test("treats the comparison as case-sensitive", () => {
    expect(validateRegisterFields("Hunter22", "hunter22")).toBe("pwdMismatch");
  });

  // A trailing space is a real character in a password and a classic
  // paste-artifact. It must fail rather than be silently trimmed away — the
  // backend stores what it is sent, so trimming here would create an account
  // whose password is not what the user typed into the first box.
  test("does not trim whitespace before comparing", () => {
    expect(validateRegisterFields("hunter22", "hunter22 ")).toBe("pwdMismatch");
  });

  test("compares unicode passwords by exact value", () => {
    expect(validateRegisterFields("密码密码密码", "密码密码密码")).toBeNull();
    expect(validateRegisterFields("密码密码密码", "密码密码密馬")).toBe("pwdMismatch");
  });
});

describe("isConfirmMismatchVisible", () => {
  test("stays quiet while the confirm field is empty", () => {
    expect(isConfirmMismatchVisible("hunter22", "")).toBe(false);
  });

  // The whole point: someone typing the right password correctly passes
  // through every prefix of it. Flagging those would paint the field red on
  // every keystroke of a correct entry.
  test("stays quiet while the confirmation is a correct prefix", () => {
    for (const prefix of ["h", "hun", "hunter", "hunter2"]) {
      expect(isConfirmMismatchVisible("hunter22", prefix)).toBe(false);
    }
  });

  test("stays quiet once the confirmation matches in full", () => {
    expect(isConfirmMismatchVisible("hunter22", "hunter22")).toBe(false);
  });

  test("flags a confirmation that has diverged", () => {
    expect(isConfirmMismatchVisible("hunter22", "hunterX")).toBe(true);
  });

  test("flags a confirmation longer than the password", () => {
    expect(isConfirmMismatchVisible("hunter22", "hunter222")).toBe(true);
  });

  test("stays quiet when both fields are empty", () => {
    expect(isConfirmMismatchVisible("", "")).toBe(false);
  });

  // Guard against a future "optimisation" that swaps the two arguments: the
  // relation is not symmetric, and getting it backwards would flag every
  // correct entry while the password field is still being typed.
  test("is not symmetric in its arguments", () => {
    expect(isConfirmMismatchVisible("hunter22", "hunter")).toBe(false);
    expect(isConfirmMismatchVisible("hunter", "hunter22")).toBe(true);
  });
});
