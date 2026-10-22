import { describe, expect, test } from "bun:test";
import { shouldMoveFocus, type FocusContainer } from "./focusRule";

// Stand-ins for DOM nodes: identity is all the rule looks at.
const body = { name: "body" } as unknown as Node;
const tileButton = { name: "退出" } as unknown as Node;
const usernameField = { name: "#set-username" } as unknown as Node;

function holding(...nodes: Node[]): FocusContainer {
  return { contains: (node) => nodes.includes(node as Node) };
}

describe("shouldMoveFocus", () => {
  test("moves focus out of something that is going away", () => {
    expect(shouldMoveFocus(tileButton, body, [holding(tileButton)])).toBe(true);
  });

  test("moves focus that has already fallen back to the body", () => {
    expect(shouldMoveFocus(body, body, [holding(tileButton)])).toBe(true);
    expect(shouldMoveFocus(null, body, [])).toBe(true);
  });

  test("leaves focus alone when the reader has moved on", () => {
    expect(shouldMoveFocus(usernameField, body, [holding(tileButton)])).toBe(false);
  });

  test("checks every container that is leaving, and copes with missing ones", () => {
    expect(shouldMoveFocus(tileButton, body, [null, undefined, holding(), holding(tileButton)])).toBe(true);
    expect(shouldMoveFocus(usernameField, body, [null, undefined])).toBe(false);
  });
});
