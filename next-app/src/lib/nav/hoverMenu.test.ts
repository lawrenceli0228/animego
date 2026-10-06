import { describe, expect, test } from "bun:test";
import { CLOSED_MENU, hoverMenu, type HoverMenuEvent, type HoverMenuState } from "./hoverMenu";

// The 分类 dropdown opens two ways: by resting the pointer on it (AniList's
// hover menu) and by pressing it (click, Enter, Space). The two have to agree
// on who closes it. A menu that a mouse user opened by hovering should close
// when the pointer leaves; one that somebody deliberately pressed open should
// not vanish because the pointer drifted.

const run = (events: HoverMenuEvent[], from: HoverMenuState = CLOSED_MENU) =>
  events.reduce(hoverMenu, from);

describe("hover", () => {
  test("resting on the trigger opens it", () => {
    expect(run(["pointer-enter"])).toEqual({ open: true, by: "pointer" });
  });

  test("leaving closes what hovering opened", () => {
    expect(run(["pointer-enter", "pointer-leave"])).toEqual(CLOSED_MENU);
  });

  test("hovering an already-pressed menu does not demote it", () => {
    expect(run(["press", "pointer-enter"])).toEqual({ open: true, by: "press" });
  });
});

describe("press", () => {
  test("opens a closed menu", () => {
    expect(run(["press"])).toEqual({ open: true, by: "press" });
  });

  test("a second press closes it", () => {
    expect(run(["press", "press"])).toEqual(CLOSED_MENU);
  });

  test("pressing a menu the pointer opened keeps it open instead of toggling it shut", () => {
    // The pointer is already resting there, so the menu opened a moment before
    // the click landed. Toggling would close it under the reader's cursor.
    expect(run(["pointer-enter", "press"])).toEqual({ open: true, by: "press" });
  });

  test("a pressed menu survives the pointer leaving", () => {
    expect(run(["press", "pointer-leave"])).toEqual({ open: true, by: "press" });
    expect(run(["pointer-enter", "press", "pointer-leave"])).toEqual({ open: true, by: "press" });
  });
});

describe("dismiss (Escape, a click elsewhere, focus leaving)", () => {
  test("closes it however it was opened", () => {
    expect(run(["pointer-enter", "dismiss"])).toEqual(CLOSED_MENU);
    expect(run(["press", "dismiss"])).toEqual(CLOSED_MENU);
  });

  test("on a closed menu is a no-op", () => {
    expect(run(["dismiss"])).toEqual(CLOSED_MENU);
  });

  test("after a dismissal the next hover opens it again", () => {
    expect(run(["press", "dismiss", "pointer-enter"])).toEqual({ open: true, by: "pointer" });
  });
});

describe("the state it hands back", () => {
  test("never mutates the previous state", () => {
    const before: HoverMenuState = { open: true, by: "pointer" };
    const snapshot = { ...before };
    hoverMenu(before, "press");
    hoverMenu(before, "dismiss");
    expect(before).toEqual(snapshot);
  });

  test("leaving a closed menu stays closed", () => {
    expect(run(["pointer-leave"])).toEqual(CLOSED_MENU);
  });
});
