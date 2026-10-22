import { describe, expect, test } from "bun:test";
import {
  canSaveName,
  envelopeData,
  maskEmail,
  passPatch,
  readSavedAccount,
  revokedCount,
  settingsErrorMessage,
} from "./settingsState";

describe("settingsErrorMessage", () => {
  test("reads standard and legacy error shapes", () => {
    expect(settingsErrorMessage({ error: { code: "BAD", message: "Nope" } })).toBe("Nope");
    expect(settingsErrorMessage({ error: "Legacy" })).toBe("Legacy");
    expect(settingsErrorMessage({ message: "Flat" })).toBe("Flat");
  });

  test("always returns a string", () => {
    expect(settingsErrorMessage({ error: { code: "BAD" } }, "Fallback")).toBe("Fallback");
    expect(settingsErrorMessage({ error: 42 }, "Fallback")).toBe("Fallback");
    expect(settingsErrorMessage(null, "Fallback")).toBe("Fallback");
  });
});

describe("envelopeData", () => {
  test("unwraps { data }", () => {
    expect(envelopeData({ data: { revoked: 2 } })).toEqual({ revoked: 2 });
    expect(envelopeData({ data: null })).toBeNull();
  });

  test("is null for anything else", () => {
    expect(envelopeData(null)).toBeNull();
    expect(envelopeData("data")).toBeNull();
    expect(envelopeData({ error: { message: "x" } })).toBeNull();
  });
});

describe("canSaveName", () => {
  test("offers 保存 for a changed name of three characters or more", () => {
    expect(canSaveName("shironeko2", "shironeko")).toBe(true);
    expect(canSaveName("  abc  ", "shironeko")).toBe(true);
    expect(canSaveName("白猫君", "shironeko")).toBe(true);
  });

  test("not for the saved name, even padded", () => {
    expect(canSaveName("shironeko", "shironeko")).toBe(false);
    expect(canSaveName(" shironeko ", "shironeko")).toBe(false);
  });

  test("not for fewer than three characters", () => {
    expect(canSaveName("ab", "shironeko")).toBe(false);
    expect(canSaveName("   ", "shironeko")).toBe(false);
    expect(canSaveName(" a b ", "shironeko")).toBe(true);
  });
});

describe("passPatch", () => {
  const saved = { photo: "/api/avatars/u.jpg", backdrop: 20665 };

  test("is null when nothing changed", () => {
    expect(passPatch(saved, saved)).toBeNull();
    expect(passPatch({ photo: null, backdrop: null }, { photo: null, backdrop: null })).toBeNull();
  });

  test("sends only the fields that changed", () => {
    expect(passPatch({ ...saved, backdrop: 127230 }, saved)).toEqual({ backdropAnilistId: 127230 });
    expect(passPatch({ ...saved, photo: "data:image/jpeg;base64,AAAA" }, saved)).toEqual({
      avatarUrl: "data:image/jpeg;base64,AAAA",
    });
    expect(passPatch({ photo: "data:x", backdrop: 1 }, saved)).toEqual({ avatarUrl: "data:x", backdropAnilistId: 1 });
  });

  test("clears with the values the endpoint reads as clear", () => {
    expect(passPatch({ photo: null, backdrop: null }, saved)).toEqual({ avatarUrl: "", backdropAnilistId: 0 });
  });

  test("does not touch its arguments", () => {
    const edited = { photo: null, backdrop: 5 };
    const before = { ...edited };
    passPatch(edited, saved);
    expect(edited).toEqual(before);
  });
});

describe("readSavedAccount", () => {
  test("reads the user PATCH /api/auth/me answers with", () => {
    const data = {
      user: {
        id: "u1",
        username: "shironeko",
        usernameHidden: false,
        email: "shironeko@example.com",
        avatarUrl: "/api/avatars/u1.jpg?v=2",
        backdropAnilistId: 20665,
      },
    };
    expect(readSavedAccount(data)).toEqual({
      username: "shironeko",
      usernameHidden: false,
      photo: "/api/avatars/u1.jpg?v=2",
      backdrop: 20665,
    });
  });

  test("reads cleared fields as cleared", () => {
    const data = { user: { username: "x", avatarUrl: null, backdropAnilistId: null } };
    expect(readSavedAccount(data)).toEqual({ username: "x", usernameHidden: false, photo: null, backdrop: null });
    const zeroed = { user: { username: "x", usernameHidden: true, avatarUrl: "", backdropAnilistId: 0 } };
    expect(readSavedAccount(zeroed)).toEqual({ username: "x", usernameHidden: true, photo: null, backdrop: null });
  });

  test("is null when there is no user to read", () => {
    expect(readSavedAccount(null)).toBeNull();
    expect(readSavedAccount({})).toBeNull();
    expect(readSavedAccount({ user: { username: 5 } })).toBeNull();
  });
});

describe("revokedCount", () => {
  test("reads the count the server reports", () => {
    expect(revokedCount({ revoked: 5 }, 2)).toBe(5);
    expect(revokedCount({ revoked: 0 }, 2)).toBe(0);
  });

  test("falls back when the count is missing or nonsense", () => {
    expect(revokedCount(null, 2)).toBe(2);
    expect(revokedCount({}, 2)).toBe(2);
    expect(revokedCount({ revoked: "5" }, 2)).toBe(2);
    expect(revokedCount({ revoked: -1 }, 2)).toBe(2);
    expect(revokedCount({ revoked: 1.5 }, 2)).toBe(2);
  });
});

describe("maskEmail", () => {
  test("keeps the first two characters of the local part and the domain", () => {
    expect(maskEmail("shironeko@example.com")).toBe("sh•••@example.com");
    expect(maskEmail("abc@qq.com")).toBe("ab•••@qq.com");
  });

  test("keeps only the first character of a one- or two-character local part", () => {
    expect(maskEmail("ab@qq.com")).toBe("a•••@qq.com");
    expect(maskEmail("a@qq.com")).toBe("a•••@qq.com");
  });

  test("splits on the last @ and never cuts a character in half", () => {
    expect(maskEmail('"a@b"@example.com')).toBe('"a•••@example.com');
    expect(maskEmail("😀😃x@example.com")).toBe("😀😃•••@example.com");
  });

  test("still masks what is not an address", () => {
    expect(maskEmail("")).toBe("•••");
    expect(maskEmail("@example.com")).toBe("•••@example.com");
    expect(maskEmail("plaintext")).toBe("pl•••");
    expect(maskEmail("  shironeko@example.com ")).toBe("sh•••@example.com");
  });
});
