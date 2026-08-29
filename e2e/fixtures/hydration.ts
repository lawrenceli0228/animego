import type { Page } from "@playwright/test";

// Wait until React has claimed a DOM node, before typing into it or clicking it.
//
// `next dev` compiles a route on demand, so between the server HTML arriving and
// React hydrating it there is a window seconds wide on a cold route. A keystroke
// that lands in that window goes into the DOM and never reaches React state: the
// box shows the text, `onChange` never fired, and the form submits empty. The
// symptom is indistinguishable from a broken feature — the probe written
// alongside #129 typed into /search three times out of six and reported the
// search box broken, and the same race is what made `auth.spec.ts` submit an
// empty email and get back "邮箱格式不正确" where the test expected a rejected
// password.
//
// This is not a sleep in disguise. React sets `__reactFiber$…` on every host
// node it owns, and it delegates events by looking that key up from the event
// target to find the node's props. The key's presence is therefore the exact
// condition for `onChange` to fire — there is no interval and no guess in it.
//
// WHAT IT DOES NOT PROVE. The fiber key appears at commit; `useEffect` callbacks
// run after. A component that registers its listener inside an effect — as
// StaleTabNotice does — can still miss a one-shot event dispatched the instant
// this resolves. For those, wait on what the effect produces, or re-dispatch
// until it lands. This helper is for input and clicks, not for effects.
//
// It lives in fixtures/ rather than specs/ because globalSetup.ts is its most
// important caller, and globalSetup imports only from fixtures/. Putting it
// under specs/ would make the setup depend on the test files it sets up for,
// which is the first dependency in that direction and not one to introduce for
// a twenty-line helper.

/**
 * Default budget, and the arithmetic behind it.
 *
 * playwright.config.ts sets `actionTimeout` and `navigationTimeout` but no
 * top-level `timeout`, so every test runs on Playwright's 30s default budget.
 * A wait longer than that budget can never report its own failure: the test
 * dies on the Playwright timeout first and the reader gets "Test timeout of
 * 30000ms exceeded" instead of either message below. 15s leaves room for the
 * `goto` that precedes it and still surfaces a diagnostic.
 *
 * The compile is not in this window — `goto` has already resolved by the time
 * anyone calls this, so the route is built and the bundle is fetched. What is
 * left is hydration, which is fast or broken.
 *
 * globalSetup has no per-test budget (there is no `globalTimeout` either), so
 * it may pass something larger if a cold boot ever needs it.
 */
const DEFAULT_HYDRATION_TIMEOUT_MS = 15_000;

type Presence = "missing" | "unhydrated" | "hydrated";

/** Runs in the page. Kept separate so the wait and the diagnosis agree. */
function probe(selector: string): Presence {
  const el = document.querySelector(selector);
  if (!el) return "missing";
  return Object.keys(el).some((k) => k.startsWith("__react"))
    ? "hydrated"
    : "unhydrated";
}

/**
 * Resolve once React owns `selector`.
 *
 * Throws with the two failure modes told apart, because they have opposite
 * fixes and every call site hands over a selector typed out by hand. A wrong
 * selector and an unhydrated page both present as "the thing I waited for
 * never arrived"; only the message distinguishes them, and one of them is
 * fixed by correcting a string while the other is not fixed by waiting longer.
 */
export async function waitForHydration(
  page: Page,
  selector: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_HYDRATION_TIMEOUT_MS;

  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
      },
      selector,
      { timeout },
    );
    return;
  } catch {
    // Fall through to classify. One extra round trip, only on failure.
  }

  let state: Presence | null = null;
  let probeError = "";
  try {
    state = await page.evaluate(probe, selector);
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  if (state === "hydrated") {
    // It arrived between the timeout firing and the probe running. Nothing is
    // wrong with the page; the budget was the problem.
    throw new Error(
      `waitForHydration: \`${selector}\` hydrated, but only after the ${timeout}ms budget ran out. ` +
        `Nothing is broken — the wait was too short for this route. Raise the timeout at this call site.`,
    );
  }

  if (state === "missing") {
    throw new Error(
      `waitForHydration: nothing matched \`${selector}\` within ${timeout}ms.\n` +
        `This is a selector problem, not a hydration problem: React never had a node to claim. ` +
        `Check the selector against the page and check the test is on the route it thinks it is. ` +
        `Raising the timeout will not help.`,
    );
  }

  if (state === "unhydrated") {
    throw new Error(
      `waitForHydration: \`${selector}\` exists but React had not claimed it after ${timeout}ms ` +
        `(no __reactFiber$ key on the node).\n` +
        `The node is server HTML that never hydrated. Typing into it now would land in the DOM and ` +
        `never reach state, so the test would fail later, somewhere else, for a reason that looks ` +
        `nothing like this.\n` +
        `Usual causes: the route's client bundle failed to load or threw during hydration — check the ` +
        `browser console output — or the dev server was still busy and ${timeout}ms was not enough.`,
    );
  }

  // Only two ways to get here, and they need different words. Saying "the
  // probe could not run" when it ran and answered would be a confident lie —
  // the exact failure this helper exists to stop the suite from producing.
  if (probeError) {
    throw new Error(
      `waitForHydration: \`${selector}\` did not hydrate within ${timeout}ms, and the follow-up probe ` +
        `could not run (${probeError}). The page was most likely navigated or closed while the wait ` +
        `was still pending.`,
    );
  }

  throw new Error(
    `waitForHydration: \`${selector}\` did not hydrate within ${timeout}ms, and the follow-up probe ` +
      `answered ${JSON.stringify(state)}, which this function does not handle. That is a bug here, ` +
      `not in the page — someone added a state to the probe without adding a message for it.`,
  );
}
