import { describe, expect, test } from "bun:test";
import { freshRead, FRESH_READ_ATTEMPTS } from "./freshRead";

// The order a fast click produces in production: the signed-in re-read is
// sent on load, the reader acts, the act's answer is applied, and only then
// does the re-read answer — with the state from before the act.

describe("freshRead", () => {
  test("a read nothing overtook is returned as it is", async () => {
    const writes = { current: 0 };
    let reads = 0;
    const result = await freshRead(writes, async () => {
      reads += 1;
      return "summary";
    });
    expect(result).toBe("summary");
    expect(reads).toBe(1);
  });

  test("a write applied while the read was in flight sends the read again", async () => {
    const writes = { current: 0 };
    const answers = ["before the like", "after the like"];
    let reads = 0;
    const result = await freshRead(writes, async () => {
      const answer = answers[reads];
      reads += 1;
      if (reads === 1) writes.current += 1; // the like lands mid-read
      return answer;
    });
    expect(result).toBe("after the like");
    expect(reads).toBe(2);
  });

  test("a write before the read started does not count against it", async () => {
    const writes = { current: 5 };
    let reads = 0;
    const result = await freshRead(writes, async () => {
      reads += 1;
      return reads;
    });
    expect(result).toBe(1);
  });

  test("gives up with null when every attempt is overtaken", async () => {
    const writes = { current: 0 };
    let reads = 0;
    const result = await freshRead(writes, async () => {
      reads += 1;
      writes.current += 1;
      return reads;
    });
    expect(result).toBeNull();
    expect(reads).toBe(FRESH_READ_ATTEMPTS);
  });

  test("a failed read is a result like any other", async () => {
    const writes = { current: 0 };
    const result = await freshRead(writes, async () => ({ ok: false as const, status: 500 }));
    expect(result).toEqual({ ok: false, status: 500 });
  });
});
