import { describe, expect, test } from 'bun:test';
import { probeRootStatus } from './probeRoot.js';

// A handle saved by an older Chrome can come back from IndexedDB in a state
// where queryPermission() never settles — not 'prompt', not a rejection.
// The probe gates the whole library page, so a call that never settles has
// to become a status instead of a page that waits forever.

const NEVER = () => new Promise(() => {});
const FAST = { permissionTimeoutMs: 20, readTimeoutMs: 40 };

function makeHandle({ perm = 'granted', query, next } = {}) {
  return {
    queryPermission: query ?? (async () => perm),
    entries: () => ({ next: next ?? (async () => ({ done: true })) }),
  };
}

function domError(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe('probeRootStatus', () => {
  test('returns ready when permission is granted and the folder reads', async () => {
    expect(await probeRootStatus(makeHandle(), FAST)).toBe('ready');
  });

  test('returns denied when permission is prompt or denied', async () => {
    expect(await probeRootStatus(makeHandle({ perm: 'prompt' }), FAST)).toBe('denied');
    expect(await probeRootStatus(makeHandle({ perm: 'denied' }), FAST)).toBe('denied');
  });

  test('returns stale when queryPermission never settles, without touching the folder', async () => {
    let read = false;
    const handle = makeHandle({ query: NEVER, next: async () => { read = true; return { done: true }; } });
    const started = Date.now();
    expect(await probeRootStatus(handle, FAST)).toBe('stale');
    expect(Date.now() - started).toBeLessThan(500);
    expect(read).toBe(false);
  });

  test('returns disconnected when the first read never settles', async () => {
    expect(await probeRootStatus(makeHandle({ next: NEVER }), FAST)).toBe('disconnected');
  });

  test('returns disconnected when the volume is gone', async () => {
    const next = async () => { throw domError('NotFoundError'); };
    expect(await probeRootStatus(makeHandle({ next }), FAST)).toBe('disconnected');
  });

  test('returns error for a missing handle', async () => {
    expect(await probeRootStatus(null, FAST)).toBe('error');
  });

  test('uses timeouts long enough for a waking drive by default', async () => {
    // A granted handle whose read takes a moment (a spinning-up disk) is
    // still ready under the default timeouts.
    const next = () => new Promise((r) => setTimeout(() => r({ done: true }), 50));
    expect(await probeRootStatus(makeHandle({ next }))).toBe('ready');
  });
});
