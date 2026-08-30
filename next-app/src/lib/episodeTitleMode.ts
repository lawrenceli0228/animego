/**
 * Which name the episode list prints — a device preference, not a server one.
 *
 * Every episode can carry two titles: the one in the reader's language and the
 * one the studio shipped. Printing both is defensible (someone matching a row
 * against a filename needs the original) but it is not a good default: two
 * lines per row turns a 13-episode list into 26 lines, and the list stops
 * being something you scan.
 *
 * So it is a choice, and it belongs on the device rather than on the account —
 * it is about how this person reads a list, the same class of thing as the
 * player's `autoMarkDone`, and gating it behind a login would mean the reader
 * who most needs the original titles (the one matching torrents) is the one
 * who cannot have them.
 *
 * Shape and reasoning follow lib/playerSettings.ts: same `PrefStore` seam so
 * tests can pass a plain object, same custom-event announcement because the
 * browser's own `storage` event only fires in OTHER tabs, and the same
 * `subscribe` + `read` pair so a component can render this value through
 * `useSyncExternalStore` without a hydration mismatch or a setState-in-effect.
 *
 * SSR-safe: nothing here touches `window` at module scope.
 */

import { prefStore, type PrefStore } from "./playerSettings";

export type EpisodeTitleMode = "localized" | "original" | "both";

/** The three, in the order the switch presents them. */
export const EPISODE_TITLE_MODES: readonly EpisodeTitleMode[] = [
  "localized",
  "original",
  "both",
];

/**
 * Same namespace as every other device preference (`animego:autoMarkDone`,
 * `animego:danmakuSpeed`). Renaming it resets everyone to the default, which
 * for this key is merely annoying rather than harmful — but treat it as
 * permanent anyway.
 */
export const EPISODE_TITLE_MODE_KEY = "animego:episodeTitleMode";

/**
 * The reader's own language.
 *
 * This is the direction a corrupt or missing value must fall: a list of
 * Japanese originals is unreadable to most of this audience, so defaulting to
 * anything else would make a storage failure look like a broken page.
 */
export const EPISODE_TITLE_MODE_DEFAULT: EpisodeTitleMode = "localized";

const CHANGE_EVENT = "animego:episodetitlemodechange";

function announce(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function isMode(value: string | null): value is EpisodeTitleMode {
  return value !== null && (EPISODE_TITLE_MODES as readonly string[]).includes(value);
}

/**
 * Which mode to render. Falls back to the default whenever the answer cannot
 * be trusted — no storage (SSR, private mode, storage disabled), never
 * written, or a value we did not write.
 *
 * Suitable as the `getSnapshot` for `useSyncExternalStore`: it returns a
 * string, so React's `Object.is` comparison is by value and there is nothing
 * to memoise.
 */
export function readEpisodeTitleMode(
  store: PrefStore | null = prefStore(),
): EpisodeTitleMode {
  if (!store) return EPISODE_TITLE_MODE_DEFAULT;
  try {
    const raw = store.getItem(EPISODE_TITLE_MODE_KEY);
    return isMode(raw) ? raw : EPISODE_TITLE_MODE_DEFAULT;
  } catch {
    return EPISODE_TITLE_MODE_DEFAULT;
  }
}

/**
 * What the server rendered, and therefore what the client's hydrating render
 * must also produce. Constant on purpose — reading storage here is what
 * creates a hydration mismatch.
 */
export function serverEpisodeTitleMode(): EpisodeTitleMode {
  return EPISODE_TITLE_MODE_DEFAULT;
}

/**
 * Persist the choice. Returns whether it actually landed.
 *
 * The return value matters for the same reason it does in playerSettings: on
 * a full or disabled store a silent failure means the reader clicks a control
 * and nothing happens. Callers rendering through `useSyncExternalStore` get
 * that behaviour for free — the switch keeps showing the stored value, which
 * is still the old one — so they do not have to check. A caller holding its
 * own copy of the state does.
 */
export function writeEpisodeTitleMode(
  mode: EpisodeTitleMode,
  store: PrefStore | null = prefStore(),
): boolean {
  if (!store) return false;
  try {
    store.setItem(EPISODE_TITLE_MODE_KEY, mode);
  } catch {
    return false;
  }
  announce();
  return true;
}

/**
 * Watch the choice. Returns the unsubscribe function, so it drops straight
 * into `useSyncExternalStore(subscribeEpisodeTitleMode, readEpisodeTitleMode,
 * serverEpisodeTitleMode)`.
 *
 * Fires for both a change made here and one made in another tab.
 */
export function subscribeEpisodeTitleMode(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
