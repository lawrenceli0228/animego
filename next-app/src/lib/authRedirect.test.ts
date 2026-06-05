import { afterEach, describe, expect, mock, test } from "bun:test";
import { redirectAfterAuth } from "./authRedirect";

// bun:test runs in node (no window). We stub window.location.replace and assert
// redirectAfterAuth does a FULL-page navigation. This locks the fix: a
// regression back to a soft Next router.replace (which updated the client-island
// Navbar only racily → "logged in but shows logged-out until refresh") would
// stop calling window.location.replace and fail this suite.

type WinLike = { location: { replace: (url: string) => void } };
const hadWindow = "window" in globalThis;
const original = (globalThis as { window?: WinLike }).window;

function stubWindow(replace: (url: string) => void): void {
  (globalThis as { window?: WinLike }).window = { location: { replace } };
}

afterEach(() => {
  if (hadWindow) {
    (globalThis as { window?: WinLike }).window = original;
  } else {
    delete (globalThis as { window?: WinLike }).window;
  }
});

describe("redirectAfterAuth", () => {
  test("performs a full-page navigation to the target", () => {
    const replace = mock((_url: string) => {});
    stubWindow(replace);
    redirectAfterAuth("/library");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/library");
  });

  test("passes the target through verbatim (query + hash preserved)", () => {
    const replace = mock((_url: string) => {});
    stubWindow(replace);
    redirectAfterAuth("/player?seriesId=abc&fileId=42#top");
    expect(replace).toHaveBeenCalledWith("/player?seriesId=abc&fileId=42#top");
  });

  test("no-ops on the server (no window) instead of throwing", () => {
    delete (globalThis as { window?: WinLike }).window;
    expect(() => redirectAfterAuth("/")).not.toThrow();
  });
});
