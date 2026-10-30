// Mounting and driving components in the DOM suites (`*.dom.tsx`): a real
// React root in a jsdom document, a `fetch` the test answers by hand, and
// clicks and keys sent the way a browser would deliver them.
//
// The document comes from ./dom. React DOM is imported only inside mount(),
// never at the top of a module: bun evaluates a CommonJS import (React DOM is
// one) before the ES modules listed above it have run, so a static import
// would load React DOM before ./dom had installed a window, and React DOM
// then falls back to its old-IE input handling for good. Suites import the
// components under test the same way, with `await import()`.
//
// Not a test file itself (no `.test.` in the name).

import "./dom";

import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";

const roots: Array<{ root: Root; host: HTMLElement }> = [];

/** Renders `node` under the language provider and lets its effects run. */
export async function mount(node: ReactNode, lang: Lang = "zh"): Promise<HTMLElement> {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
  });
  roots.push({ root, host });
  return host;
}

/** Unmounts everything `mount` rendered, portals included. */
export async function unmountAll(): Promise<void> {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
  document.body.replaceChildren();
}

/** Lets pending promises, effects and timers up to `ms` settle. */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error("click: no such element");
  await act(async () => {
    el.click();
  });
}

/** A keydown, sent where a browser sends it: to whatever has focus. */
export async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Types into a controlled input the way React listens for it. */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The button whose visible text, or else aria-label, is exactly `name`. */
export function button(scope: ParentNode, name: string): HTMLButtonElement {
  const all = Array.from(scope.querySelectorAll("button"));
  const found =
    all.find((b) => b.textContent?.trim() === name) ?? all.find((b) => b.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no button named "${name}"`);
  return found;
}

/** What has focus, for assertion messages: "<button> 取消", or "<body>". */
export function describeFocus(): string {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  const label = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
  return `<${el.tagName.toLowerCase()}> ${label}`.trim();
}

// ─── fetch, answered by the test ─────────────────────────────────────────

export interface PendingFetch {
  url: string;
  /** Set when the caller aborted the request. */
  aborted: boolean;
  /** Answers with a JSON body. */
  respond(body: unknown, status?: number): Promise<void>;
}

/**
 * Replaces `fetch` with one whose requests wait until the test answers them,
 * so a test can hold a request open while it clicks something else. Every
 * request lands in `requests`, aborted ones included.
 */
export function holdFetch(): { requests: PendingFetch[]; restore(): void } {
  const original = globalThis.fetch;
  const requests: PendingFetch[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const pending: PendingFetch = {
        url: String(input),
        aborted: false,
        respond: async (body, status = 200) => {
          await act(async () => {
            resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
            await new Promise((r) => setTimeout(r, 0));
          });
        },
      };
      requests.push(pending);
      init?.signal?.addEventListener("abort", () => {
        pending.aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  globalThis.fetch = fake as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
