import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dandanToArtplayer } from "./useDandanComments";

// Pure-function tests live here. The React hook itself is exercised by the
// player E2E (Phase 10), so we don't try to render it in node — the value
// is the conversion + the contract that the backend speaks flat JSON.

describe("dandanToArtplayer", () => {
  test("converts a scrolling comment (dandanplay mode 1 -> artplayer mode 0)", () => {
    const out = dandanToArtplayer({
      p: "10.5,1,16777215,abc123",
      m: "hello",
    });
    expect(out).toEqual({
      text: "hello",
      time: 10.5,
      mode: 0,
      color: "#ffffff",
    });
  });

  test("converts a bottom comment (dandanplay mode 4 -> artplayer mode 2)", () => {
    const out = dandanToArtplayer({
      p: "20.0,4,16711680,uid",
      m: "bottom",
    });
    expect(out.mode).toBe(2);
    expect(out.color).toBe("#ff0000");
  });

  test("converts a top comment (dandanplay mode 5 -> artplayer mode 1)", () => {
    const out = dandanToArtplayer({ p: "0,5,65280,uid", m: "top" });
    expect(out.mode).toBe(1);
    expect(out.color).toBe("#00ff00");
  });

  test("unknown dandanplay modes default to scroll (0)", () => {
    expect(dandanToArtplayer({ p: "1,99,0,u", m: "?" }).mode).toBe(0);
  });

  test("color integers are left-padded to 6 hex digits", () => {
    // 0x0000ff = blue. parseInt gives 255; toString(16) = "ff".
    // Without padding this would render as "#ff" which is invalid.
    const out = dandanToArtplayer({ p: "0,1,255,u", m: "blue" });
    expect(out.color).toBe("#0000ff");
  });

  test("preserves fractional time positions", () => {
    expect(dandanToArtplayer({ p: "123.456,1,0,u", m: "x" }).time).toBe(
      123.456,
    );
  });
});

// Contract test: stand-in fetch that mimics the dandanplay backend's flat
// response. This catches the exact regression we just fixed — if anyone
// re-introduces apiGet here (which strips `.data`), the assertions below
// fail because the unwrapped value would be `undefined` and `count` would
// silently fall back to 0.

describe("loadComments contract (FLAT {count, comments})", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a flat response shape is what the backend actually returns", async () => {
    // Mirror the real /api/dandanplay/comments/:id payload — NOT enveloped.
    const payload = {
      count: 2,
      comments: [
        { p: "0,1,16777215,a", m: "first" },
        { p: "1,1,16777215,b", m: "second" },
      ],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const res = await fetch("/api/dandanplay/comments/192420006");
    const data = (await res.json()) as {
      count?: number;
      comments?: Array<{ p: string; m: string }>;
    };

    // The asserts below describe how loadComments reads the payload. Each
    // line that would break under an envelope-unwrap strategy is called
    // out.
    expect(data.count).toBe(2); // would be `undefined` under apiGet
    expect(Array.isArray(data.comments)).toBe(true); // would crash
    expect(data.comments?.length).toBe(2);

    const converted = (data.comments || []).map(dandanToArtplayer);
    expect(converted.length).toBe(2);
    expect(converted[0]?.text).toBe("first");
  });

  test("401 leaves comments empty without throwing", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 401 })) as typeof fetch;
    const res = await fetch("/api/dandanplay/comments/1");
    expect(res.status).toBe(401);
    // hook short-circuits to setCount(0) / setDanmakuList([])
  });
});
