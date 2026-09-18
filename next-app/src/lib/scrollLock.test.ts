import { describe, expect, test } from "bun:test";
import { lockScroll, type ScrollRoot } from "./scrollLock";

// bun:test runs in node — no document. Every case hands the lock a stub root
// so the assertions are about what the module writes, not about a DOM.

function stubRoot(clientWidth: number): ScrollRoot {
  return { style: { overflow: "", paddingRight: "" }, clientWidth };
}

describe("lockScroll", () => {
  test("hides overflow on the root it is given and restores it on release", () => {
    const root = stubRoot(1200);

    const release = lockScroll(root, 1200);

    expect(root.style.overflow).toBe("hidden");
    release();
    expect(root.style.overflow).toBe("");
  });

  test("restores whatever inline overflow the root had before", () => {
    const root = stubRoot(1200);
    root.style.overflow = "clip";

    const release = lockScroll(root, 1200);
    expect(root.style.overflow).toBe("hidden");

    release();
    expect(root.style.overflow).toBe("clip");
  });

  test("pads the root by the scrollbar it just removed", () => {
    // Classic scrollbars: the viewport is 17px wider than the root's
    // client box. Hiding overflow drops the bar; the padding keeps the
    // page from jumping sideways.
    const root = stubRoot(1183);

    const release = lockScroll(root, 1200);
    expect(root.style.paddingRight).toBe("17px");

    release();
    expect(root.style.paddingRight).toBe("");
  });

  test("adds no padding for overlay scrollbars", () => {
    const root = stubRoot(1200);

    const release = lockScroll(root, 1200);
    expect(root.style.paddingRight).toBe("");

    release();
  });

  test("overlapping locks hold the page until the last one is released", () => {
    const root = stubRoot(1200);

    const releaseOuter = lockScroll(root, 1200);
    const releaseInner = lockScroll(root, 1200);
    expect(root.style.overflow).toBe("hidden");

    releaseOuter();
    expect(root.style.overflow).toBe("hidden");

    releaseInner();
    expect(root.style.overflow).toBe("");
  });

  test("a second lock does not overwrite the saved state with 'hidden'", () => {
    const root = stubRoot(1200);
    root.style.overflow = "clip";

    const releaseA = lockScroll(root, 1200);
    const releaseB = lockScroll(root, 1200);
    releaseA();
    releaseB();

    expect(root.style.overflow).toBe("clip");
  });

  test("releasing twice is a no-op", () => {
    const root = stubRoot(1200);

    const releaseA = lockScroll(root, 1200);
    const releaseB = lockScroll(root, 1200);
    releaseA();
    releaseA();
    expect(root.style.overflow).toBe("hidden");

    releaseB();
    expect(root.style.overflow).toBe("");
  });
});
