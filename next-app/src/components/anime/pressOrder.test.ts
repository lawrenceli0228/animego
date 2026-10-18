import { describe, expect, test } from "bun:test";

import { createPressOrder } from "./pressOrder";

describe("createPressOrder", () => {
  test("confirmations that come back in order all show", () => {
    const order = createPressOrder();
    const a = order.takeTurn();
    const b = order.takeTurn();
    expect(order.mayConfirm(a)).toBe(true);
    expect(order.mayConfirm(b)).toBe(true);
  });

  test("a slow write cannot replace the toast of a press made after it", () => {
    const order = createPressOrder();
    const first = order.takeTurn();
    const second = order.takeTurn();
    const third = order.takeTurn();
    expect(order.mayConfirm(third)).toBe(true);
    expect(order.mayConfirm(second)).toBe(false);
    expect(order.mayConfirm(first)).toBe(false);
  });

  test("a press that failed leaves the order to the next one", () => {
    const order = createPressOrder();
    order.takeTurn(); // its write failed: no confirmation is asked for
    const next = order.takeTurn();
    expect(order.mayConfirm(next)).toBe(true);
  });

  test("a later press after a confirmation still shows", () => {
    const order = createPressOrder();
    expect(order.mayConfirm(order.takeTurn())).toBe(true);
    expect(order.mayConfirm(order.takeTurn())).toBe(true);
  });
});
