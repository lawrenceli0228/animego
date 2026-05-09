// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { probeRootStatus } from '../lib/library/handles/probeRoot.js';

function makeHandle({ permission, entriesError, empty }) {
  return {
    queryPermission: vi.fn().mockResolvedValue(permission),
    entries: vi.fn(() => {
      if (entriesError) {
        return {
          next: vi.fn().mockRejectedValue(entriesError),
        };
      }
      let yielded = false;
      return {
        next: vi.fn(() => {
          if (empty || yielded) return Promise.resolve({ done: true });
          yielded = true;
          return Promise.resolve({ value: ['x', { kind: 'file' }], done: false });
        }),
      };
    }),
  };
}

describe('probeRootStatus', () => {
  it('returns "ready" when permission is granted and entries iterates', async () => {
    const h = makeHandle({ permission: 'granted' });
    expect(await probeRootStatus(h)).toBe('ready');
  });

  it('returns "ready" for an empty but mounted directory', async () => {
    const h = makeHandle({ permission: 'granted', empty: true });
    expect(await probeRootStatus(h)).toBe('ready');
  });

  it('returns "denied" when queryPermission says denied', async () => {
    const h = makeHandle({ permission: 'denied' });
    expect(await probeRootStatus(h)).toBe('denied');
    // Should short-circuit before touching entries()
    expect(h.entries).not.toHaveBeenCalled();
  });

  it('returns "denied" for "prompt" state (cannot prompt without user gesture)', async () => {
    const h = makeHandle({ permission: 'prompt' });
    expect(await probeRootStatus(h)).toBe('denied');
    expect(h.entries).not.toHaveBeenCalled();
  });

  it('returns "disconnected" when entries throws NotFoundError', async () => {
    const err = Object.assign(new Error('drive gone'), { name: 'NotFoundError' });
    const h = makeHandle({ permission: 'granted', entriesError: err });
    expect(await probeRootStatus(h)).toBe('disconnected');
  });

  it('returns "disconnected" on NotReadableError', async () => {
    const err = Object.assign(new Error('IO failed'), { name: 'NotReadableError' });
    const h = makeHandle({ permission: 'granted', entriesError: err });
    expect(await probeRootStatus(h)).toBe('disconnected');
  });

  it('returns "denied" on NotAllowedError thrown mid-iteration', async () => {
    const err = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    const h = makeHandle({ permission: 'granted', entriesError: err });
    expect(await probeRootStatus(h)).toBe('denied');
  });

  it('returns "error" on unknown errors', async () => {
    const err = Object.assign(new Error('weird'), { name: 'WeirdError' });
    const h = makeHandle({ permission: 'granted', entriesError: err });
    expect(await probeRootStatus(h)).toBe('error');
  });

  it('returns "error" for null/undefined handle', async () => {
    expect(await probeRootStatus(null)).toBe('error');
    expect(await probeRootStatus(undefined)).toBe('error');
  });

  it('skips queryPermission when method is missing (older platforms)', async () => {
    let yielded = false;
    const h = {
      entries: vi.fn(() => ({
        next: vi.fn(() => {
          if (yielded) return Promise.resolve({ done: true });
          yielded = true;
          return Promise.resolve({ value: ['x', {}], done: false });
        }),
      })),
    };
    expect(await probeRootStatus(/** @type {any} */ (h))).toBe('ready');
  });
});
