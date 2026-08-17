// @ts-nocheck
// Thin adapter over the FileSystemObserver API (Chrome/Edge 133+ desktop,
// enabled by default; not in Firefox/Safari/Android). The spec has NOT
// landed in whatwg/fs yet, so every touch point is wrapped defensively and
// callers depend only on this module's own surface — never on the raw API.
//
// Observer events are treated as HINTS, never as truth: the only action ever
// taken is "run the same reconciliation diff scan" (rescanController). That
// matches the platform guidance — 'unknown' officially means "zero or more
// events were missed, poll instead", and OS-level fidelity varies (Windows
// reports cross-directory moves as disappeared+appeared).
//
// Lifecycle: observation only lives while the page does. The mount
// reconciliation scan therefore remains the source of truth; this adapter
// merely upgrades "found on next tab-return" to "found while the page is
// open".

/**
 * Debounce window for change records. Long enough to swallow the write
 * bursts a finishing download produces, short enough to keep the "appears
 * within seconds while the page is open" promise. The scan's own
 * quiet-period guard (rescanService) stays authoritative for still-growing
 * files — this debounce never bypasses it.
 */
export const WATCH_DEBOUNCE_MS = 10_000;

/**
 * @returns {boolean} True when the environment ships FileSystemObserver.
 */
export function isFolderWatchSupported() {
  return typeof window !== "undefined" && "FileSystemObserver" in window;
}

/**
 * @param {{
 *   onChange: () => void,
 *   onRootError?: (record: any) => void,
 *   debounceMs?: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   ObserverCtor?: any,
 * }} params
 * @returns {{
 *   supported: boolean,
 *   observe(handle: FileSystemDirectoryHandle): Promise<void>,
 *   disconnect(): void,
 * }}
 */
export function createFolderWatcher({
  onChange,
  onRootError,
  debounceMs = WATCH_DEBOUNCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  ObserverCtor,
}) {
  const Ctor =
    ObserverCtor ??
    (isFolderWatchSupported() ? window.FileSystemObserver : null);

  if (!Ctor) {
    return {
      supported: false,
      observe: async () => {},
      disconnect: () => {},
    };
  }

  let observer = null;
  let timer = null;
  let disposed = false;

  const fireChange = () => {
    timer = null;
    if (!disposed) onChange();
  };

  const schedule = () => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fireChange, debounceMs);
  };

  const handleRecords = (records) => {
    if (disposed) return;
    let missedEvents = false;
    for (const record of records ?? []) {
      const type = record?.type;
      if (type === "errored") {
        // Observation on some root became invalid (root deleted, permission
        // revoked). Not a content change — surface for a re-probe instead.
        try {
          onRootError?.(record);
        } catch {
          /* host callback must not break the watcher */
        }
        continue;
      }
      if (type === "unknown") {
        // Official semantics: zero or more events were missed — poll now.
        missedEvents = true;
      }
      // appeared / disappeared / modified / moved → debounced rescan.
    }
    if (missedEvents) {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      onChange();
      return;
    }
    schedule();
  };

  return {
    supported: true,

    async observe(handle) {
      try {
        if (!observer) observer = new Ctor(handleRecords);
        await observer.observe(handle, { recursive: true });
      } catch {
        // Unstandardized API — a shape change or per-handle failure degrades
        // to "no live watch for this root"; the reconciliation scans still
        // cover it.
      }
    },

    disconnect() {
      disposed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      try {
        observer?.disconnect();
      } catch {
        /* best-effort teardown */
      }
      observer = null;
    },
  };
}
