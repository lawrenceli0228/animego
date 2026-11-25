import { describe, expect, test } from 'bun:test';
import { ensurePermission } from './permissionGate.js';

const NEVER = () => new Promise(() => {});
const FAST = { permissionTimeoutMs: 20 };

function makeHandle({ perm = 'granted', query, request } = {}) {
  const calls = { request: 0 };
  return {
    calls,
    queryPermission: query ?? (async () => perm),
    requestPermission: async (...args) => {
      calls.request += 1;
      return request ? request(...args) : 'granted';
    },
  };
}

describe('ensurePermission', () => {
  test('returns granted without prompting when already granted', async () => {
    const h = makeHandle();
    expect(await ensurePermission(h, 'read', FAST)).toBe('granted');
    expect(h.calls.request).toBe(0);
  });

  test('prompts when the state is prompt', async () => {
    const h = makeHandle({ perm: 'prompt', request: async () => 'granted' });
    expect(await ensurePermission(h, 'read', FAST)).toBe('granted');
    expect(h.calls.request).toBe(1);
  });

  test('returns denied when the prompt is refused', async () => {
    const h = makeHandle({ perm: 'prompt', request: async () => 'denied' });
    expect(await ensurePermission(h, 'read', FAST)).toBe('denied');
  });

  test('returns stale and does not prompt when queryPermission never settles', async () => {
    const h = makeHandle({ query: NEVER });
    const started = Date.now();
    expect(await ensurePermission(h, 'read', FAST)).toBe('stale');
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.calls.request).toBe(0);
  });

  test('returns denied when queryPermission throws', async () => {
    const h = makeHandle({ query: async () => { throw new Error('boom'); } });
    expect(await ensurePermission(h, 'read', FAST)).toBe('denied');
  });
});
