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
  test("round-trips per reader and anime", () => {
    setWindow({ localStorage: memoryStorage() });
    expect(saveDraft("alice", 1, { summary: "总结", body: "正文", isSpoiler: true, isPrivate: false })).toBe(true);
    expect(loadDraft("alice", 1)).toMatchObject({ summary: "总结", body: "正文", isSpoiler: true, isPrivate: false });
    expect(loadDraft("alice", 2)).toBeNull();
    clearDraft("alice", 1);
    expect(loadDraft("alice", 1)).toBeNull();
  });

  test("another account on the same browser never gets the draft", () => {
    setWindow({ localStorage: memoryStorage() });
    saveDraft("alice", 1, { summary: "只写给自己", body: "私密的观后感", isSpoiler: false, isPrivate: true });
    expect(loadDraft("bob", 1)).toBeNull();
    clearDraft("bob", 1);
    expect(loadDraft("alice", 1)).toMatchObject({ summary: "只写给自己" });
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
    expect(saveDraft("alice", 1, { summary: "", body: "", isSpoiler: false, isPrivate: false })).toBe(false);
    expect(loadDraft("alice", 1)).toBeNull();
    setWindow(undefined);
    expect(loadDraft("alice", 1)).toBeNull();
    expect(() => clearDraft("alice", 1)).not.toThrow();
  });

  test("a corrupt value is no draft", () => {
    const storage = memoryStorage();
    storage.setItem("agc:review-draft:alice:1", "{not json");
    setWindow({ localStorage: storage });
    expect(loadDraft("alice", 1)).toBeNull();
  });
});
