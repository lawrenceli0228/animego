import { describe, expect, test } from "bun:test";

import { toastsToDismiss } from "./toastLimit";

const on = (id: string) => ({ id, visible: true });
const off = (id: string) => ({ id, visible: false });

describe("toastsToDismiss", () => {
  test("one toast, or none, stays", () => {
    expect(toastsToDismiss([], new Set())).toEqual([]);
    expect(toastsToDismiss([on("a")], new Set())).toEqual([]);
    expect(toastsToDismiss([on("a"), off("b")], new Set(["b"]))).toEqual([]);
  });

  test("a new toast replaces the one on screen", () => {
    // The store lists newest first.
    expect(toastsToDismiss([on("b"), on("a")], new Set(["a"]))).toEqual(["a"]);
  });

  test("six quick follows leave the last one", () => {
    const store = ["f6", "f5", "f4", "f3", "f2", "f1"].map(on);
    expect(toastsToDismiss(store, new Set(["f5", "f4", "f3", "f2", "f1"]))).toEqual(["f5", "f4", "f3", "f2", "f1"]);
  });

  test("a toast that reappears through an update wins, though it was created first", () => {
    // A loading toast updated by id keeps its old place behind a newer error.
    expect(toastsToDismiss([on("error"), on("loading")], new Set(["error"]))).toEqual(["error"]);
  });

  test("several new at once: the newest", () => {
    expect(toastsToDismiss([on("c"), on("b"), on("a")], new Set(["a"]))).toEqual(["b", "a"]);
    expect(toastsToDismiss([on("b"), on("a")], new Set())).toEqual(["a"]);
  });

  test("nothing new: the newest stays", () => {
    expect(toastsToDismiss([on("b"), on("a")], new Set(["a", "b"]))).toEqual(["a"]);
  });
});
