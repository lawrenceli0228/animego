import { describe, expect, test } from "bun:test";
import { latestWins, type SendResult } from "./latestWins";

/** A `send` whose answers the test hands out one at a time. */
function scriptedSend() {
  const sent: boolean[] = [];
  const pending: Array<(result: SendResult) => void> = [];
  const send = (value: boolean) =>
    new Promise<SendResult>((resolve) => {
      sent.push(value);
      pending.push(resolve);
    });
  /** Answer the oldest request still out, then let the queue move on. */
  const answer = async (result: SendResult) => {
    pending.shift()?.(result);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { send, sent, answer, outstanding: () => pending.length };
}

function harness(saved = true) {
  const script = scriptedSend();
  const events: string[] = [];
  const sync = latestWins<boolean>({
    saved,
    send: script.send,
    onBusy: (busy) => events.push(busy ? "busy" : "idle"),
    onSaved: (value) => events.push(`saved:${value}`),
    onFailed: (value, error) => events.push(`failed:${value}:${error}`),
  });
  return { ...script, events, sync };
}

const OK: SendResult = { ok: true, error: "" };

describe("latestWins", () => {
  test("saves a flip and reports it once", async () => {
    const h = harness(true);
    h.sync.want(false);
    expect(h.sent).toEqual([false]);
    await h.answer(OK);
    expect(h.events).toEqual(["busy", "idle", "saved:false"]);
  });

  test("a flip made while a save is out is sent after it, and only the end is reported", async () => {
    const h = harness(true);
    h.sync.want(false);
    h.sync.want(true);
    expect(h.sent).toEqual([false]);
    expect(h.outstanding()).toBe(1);
    await h.answer(OK);
    expect(h.sent).toEqual([false, true]);
    expect(h.events).toEqual(["busy"]);
    await h.answer(OK);
    expect(h.events).toEqual(["busy", "idle", "saved:true"]);
  });

  test("several flips while one is out collapse into the last", async () => {
    const h = harness(true);
    h.sync.want(false);
    h.sync.want(true);
    h.sync.want(false);
    await h.answer(OK);
    // The server already holds false: nothing more to send.
    expect(h.sent).toEqual([false]);
    expect(h.events).toEqual(["busy", "idle", "saved:false"]);
  });

  test("a failure reports what the server still holds, and drops later asks", async () => {
    const h = harness(true);
    h.sync.want(false);
    h.sync.want(true);
    await h.answer({ ok: false, error: "update privacy failed" });
    expect(h.sent).toEqual([false]);
    expect(h.events).toEqual(["busy", "idle", "failed:true:update privacy failed"]);
  });

  test("a send that throws is a failure, not a crash", async () => {
    const events: string[] = [];
    const sync = latestWins<boolean>({
      saved: true,
      send: async () => {
        throw new Error("offline");
      },
      onSaved: () => events.push("saved"),
      onFailed: (value, error) => events.push(`failed:${value}:${error}`),
    });
    sync.want(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["failed:true:offline"]);
  });

  test("asking for what the server already holds sends nothing", async () => {
    const h = harness(true);
    h.sync.want(true);
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test("after one save, the next flip starts from the new value", async () => {
    const h = harness(true);
    h.sync.want(false);
    await h.answer(OK);
    h.sync.want(true);
    await h.answer(OK);
    expect(h.sent).toEqual([false, true]);
    expect(h.events).toEqual(["busy", "idle", "saved:false", "busy", "idle", "saved:true"]);
  });
});
