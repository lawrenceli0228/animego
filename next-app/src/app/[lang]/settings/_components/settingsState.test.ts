import { describe, expect, test } from "bun:test";
import { settingsErrorMessage } from "./settingsState";

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
