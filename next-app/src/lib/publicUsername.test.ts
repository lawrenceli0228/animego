import { describe, expect, test } from "bun:test";
import { isMaskedUsername, MASKED_USERNAME_PREFIX } from "./publicUsername";

// The values below are real output from go-api/internal/pii for the shapes
// found in production on 2026-08-16, so this file also pins the cross-language
// contract: if the Go side ever changes the prefix or the hex width, these
// stop matching and the tooltip silently disappears.
describe("isMaskedUsername", () => {
  test("recognises the handles go-api actually emits", () => {
    // Slug("2548537435@qq.com") and Slug("17566285293") respectively.
    expect(isMaskedUsername("user-8c73f3856f")).toBe(true);
    expect(isMaskedUsername("user-c3b19c6642")).toBe(true);
  });

  test("leaves real usernames alone", () => {
    for (const name of ["lawrence", "无始冬", "xin", "user_2024", "2024", "kirito-kun"]) {
      expect(isMaskedUsername(name)).toBe(false);
    }
  });

  test("does not fire on a lookalike that is not the exact shape", () => {
    // Ten hex is the contract. Anything else is someone's real name.
    expect(isMaskedUsername("user-")).toBe(false);
    expect(isMaskedUsername("user-8c73f385")).toBe(false); // 8 chars
    expect(isMaskedUsername("user-8c73f3856f0")).toBe(false); // 11 chars
    expect(isMaskedUsername("user-8C73F3856F")).toBe(false); // uppercase
    expect(isMaskedUsername("user-8c73f3856g")).toBe(false); // 'g' is not hex
    expect(isMaskedUsername("xuser-8c73f3856f")).toBe(false); // not anchored
    expect(isMaskedUsername("user-8c73f3856f ")).toBe(false); // trailing space
  });

  test("never claims a contact detail is masked", () => {
    // If one of these ever returned true it would mean the mask failed
    // upstream and we were about to reassure the viewer about a live
    // address on screen.
    expect(isMaskedUsername("2548537435@qq.com")).toBe(false);
    expect(isMaskedUsername("17566285293")).toBe(false);
  });

  test("handles null and undefined", () => {
    expect(isMaskedUsername(null)).toBe(false);
    expect(isMaskedUsername(undefined)).toBe(false);
    expect(isMaskedUsername("")).toBe(false);
  });

  test("the exported prefix matches what the matcher accepts", () => {
    expect(isMaskedUsername(`${MASKED_USERNAME_PREFIX}8c73f3856f`)).toBe(true);
  });
});
