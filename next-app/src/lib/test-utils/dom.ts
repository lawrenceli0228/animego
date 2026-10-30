// A browser document for the DOM suites (`*.dom.tsx`), which mount real
// components with React DOM and drive them by focus, clicks and keys.
//
// Importing this module installs a jsdom window as the globals React DOM and
// the components reach for, so it must be the suite's first import: React DOM
// reads `window` as it loads, and next/dynamic decides once, at import time,
// whether it is running on a server.
//
// That is also why the suites never run in the main `bun test` process (see
// domSuites.test.ts): bun shares one process and one module cache across test
// files, the rest of the suite is written for no DOM at all, and a module
// that first loaded under one of these globals keeps what it saw.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
const win = dom.window as unknown as Record<string, unknown>;

function put(key: string, value: unknown): void {
  try {
    g[key] = value;
  } catch {
    // A read-only global: defined below instead.
  }
  if (g[key] !== value) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// Everything the window has that the process does not: document, the element
// and event classes, getComputedStyle, requestAnimationFrame… Bun's own
// fetch, Response, AbortController, URL and timers stay, which is what the
// suites stub and await.
for (const key of Object.getOwnPropertyNames(win)) {
  if (key.startsWith("_") || key in globalThis) continue;
  put(key, win[key]);
}

// Bun has Event classes and a navigator of its own, and a Bun Event cannot be
// dispatched on a jsdom node: these come from the window regardless.
for (const key of ["Event", "CustomEvent", "EventTarget", "navigator"]) put(key, win[key]);
put("window", dom.window);
put("IS_REACT_ACT_ENVIRONMENT", true);
