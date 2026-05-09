// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { ensurePermission } from '../lib/library/handles/permissionGate.js';

/**
 * @param {'granted'|'prompt'|'denied'} queryResult
 * @param {'granted'|'denied'} [requestResult]
 */
function makeFakeHandle(queryResult, requestResult = 'granted') {
  return {
    name: 'testdir',
    kind: 'directory',
    queryPermission: vi.fn().mockResolvedValue(queryResult),
    requestPermission: vi.fn().mockResolvedValue(requestResult),
  };
}

describe('ensurePermission', () => {
  it('returns "granted" immediately when queryPermission returns "granted"', async () => {
    const handle = makeFakeHandle('granted');
    const result = await ensurePermission(handle);
    expect(result).toBe('granted');
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('calls requestPermission when queryPermission returns "prompt" and returns its result', async () => {
    const handle = makeFakeHandle('prompt', 'granted');
    const result = await ensurePermission(handle, 'read');
    expect(result).toBe('granted');
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('returns "denied" when queryPermission returns "denied" without calling requestPermission', async () => {
    const handle = makeFakeHandle('denied');
    const result = await ensurePermission(handle);
    expect(result).toBe('denied');
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('returns "denied" when requestPermission resolves to "denied"', async () => {
    const handle = makeFakeHandle('prompt', 'denied');
    const result = await ensurePermission(handle, 'readwrite');
    expect(result).toBe('denied');
  });

  it('returns "denied" when queryPermission throws (revoked handle)', async () => {
    const handle = {
      name: 'revoked',
      kind: 'directory',
      queryPermission: vi.fn().mockRejectedValue(new Error('InvalidStateError')),
      requestPermission: vi.fn(),
    };
    const result = await ensurePermission(handle);
    expect(result).toBe('denied');
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('returns "denied" when requestPermission throws', async () => {
    const handle = {
      name: 'errdir',
      kind: 'directory',
      queryPermission: vi.fn().mockResolvedValue('prompt'),
      requestPermission: vi.fn().mockRejectedValue(new Error('SecurityError')),
    };
    const result = await ensurePermission(handle, 'read');
    expect(result).toBe('denied');
  });

  it('defaults mode to "read" when not specified', async () => {
    const handle = makeFakeHandle('prompt', 'granted');
    await ensurePermission(handle);
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });
});
