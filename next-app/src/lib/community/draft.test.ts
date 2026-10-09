import { afterEach, describe, expect, test } from "bun:test";
import { clearDraft, loadDraft, saveDraft } from "./draft";

type WindowLike = { localStorage: Storage } | undefined;
const originalWindow = (globalThis as { window?: WindowLike }).window;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function setWindow(value: WindowLike): void {
  (globalThis as { window?: WindowLike }).window = value;
}

afterEach(() => setWindow(originalWindow));

describe("the 存草稿 draft", () => {
  test("round-trips per anime", () => {
    setWindow({ localStorage: memoryStorage() });
    expect(saveDraft(1, { summary: "总结", body: "正文", isSpoiler: true, isPrivate: false })).toBe(true);
    expect(loadDraft(1)).toMatchObject({ summary: "总结", body: "正文", isSpoiler: true, isPrivate: false });
    expect(loadDraft(2)).toBeNull();
    clearDraft(1);
    expect(loadDraft(1)).toBeNull();
  });

  test("storage that throws or is missing degrades to no draft", () => {
    const throwing = memoryStorage();
    throwing.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    throwing.getItem = () => {
      throw new Error("SecurityError");
    };
    setWindow({ localStorage: throwing });
    expect(saveDraft(1, { summary: "", body: "", isSpoiler: false, isPrivate: false })).toBe(false);
    expect(loadDraft(1)).toBeNull();
    setWindow(undefined);
    expect(loadDraft(1)).toBeNull();
    expect(() => clearDraft(1)).not.toThrow();
  });

  test("a corrupt value is no draft", () => {
    const storage = memoryStorage();
    storage.setItem("agc:review-draft:1", "{not json");
    setWindow({ localStorage: storage });
    expect(loadDraft(1)).toBeNull();
  });
});
