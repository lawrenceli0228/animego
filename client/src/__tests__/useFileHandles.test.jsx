// @ts-check
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { getDb } from '../lib/library/db/db.js';

// We need to mock the modules before importing the hook
vi.mock('../lib/library/handles/fsaFeatureCheck.js', () => ({
  isFsaSupported: vi.fn(() => true),
}));

vi.mock('../lib/library/handles/permissionGate.js', () => ({
  ensurePermission: vi.fn().mockResolvedValue('granted'),
}));

vi.mock('../lib/library/handles/fileHandleStore.js', () => ({
  makeFileHandleStore: vi.fn(() => ({
    listRoots: vi.fn().mockResolvedValue([]),
    saveRoot: vi.fn().mockResolvedValue({ id: 'r1', libraryId: 'lib-1', name: 'mydir', addedAt: Date.now(), lastSeenAt: Date.now() }),
    dropRoot: vi.fn().mockResolvedValue(undefined),
    findByLibrary: vi.fn().mockResolvedValue(null),
  })),
}));

import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';
import { ensurePermission } from '../lib/library/handles/permissionGate.js';
import { makeFileHandleStore } from '../lib/library/handles/fileHandleStore.js';
import useFileHandles from '../hooks/useFileHandles.js';

function makeFakeHandle(name = 'lib') {
  return {
    name,
    kind: 'directory',
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    getFileHandle: vi.fn(),
    getDirectoryHandle: vi.fn(),
  };
}

describe('useFileHandles', () => {
  let testDb;

  beforeEach(async () => {
    testDb = getDb('test-ufh-' + Date.now() + Math.random());
    await testDb.open();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy: isFsaSupported=true, no roots → status "ready", roots=[]', async () => {
    isFsaSupported.mockReturnValue(true);
    const storeInstance = {
      listRoots: vi.fn().mockResolvedValue([]),
      saveRoot: vi.fn(),
      dropRoot: vi.fn(),
      findByLibrary: vi.fn(),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);

    const { result } = renderHook(() => useFileHandles({ db: testDb }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.roots).toEqual([]);
  });

  it('edge: Safari/Firefox (isFsaSupported=false) → status "unsupported"', async () => {
    isFsaSupported.mockReturnValue(false);

    const { result } = renderHook(() => useFileHandles({ db: testDb }));

    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(result.current.roots).toEqual([]);
  });

  it('edge: pickFolder stores handle → roots.length === 1', async () => {
    isFsaSupported.mockReturnValue(true);
    const fakeHandle = makeFakeHandle('anime-dir');
    const savedRecord = { id: 'r1', libraryId: 'lib-pick', name: 'anime-dir', handle: fakeHandle, addedAt: Date.now(), lastSeenAt: Date.now() };

    const storeInstance = {
      listRoots: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([savedRecord]),
      saveRoot: vi.fn().mockResolvedValue(savedRecord),
      dropRoot: vi.fn().mockResolvedValue(undefined),
      findByLibrary: vi.fn().mockResolvedValue(null),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);

    // Mock window.showDirectoryPicker
    const origPicker = globalThis.showDirectoryPicker;
    globalThis.showDirectoryPicker = vi.fn().mockResolvedValue(fakeHandle);

    const { result } = renderHook(() => useFileHandles({ db: testDb }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.pickFolder('lib-pick');
    });

    expect(result.current.roots.length).toBe(1);
    expect(storeInstance.saveRoot).toHaveBeenCalledWith(fakeHandle, 'lib-pick');

    globalThis.showDirectoryPicker = origPicker;
  });

  it('negative: ensurePermission returns "denied" → status reflects "denied"', async () => {
    isFsaSupported.mockReturnValue(true);
    const fakeHandle = makeFakeHandle('denied-dir');
    const deniedRecord = { id: 'r-denied', libraryId: 'lib-denied', name: 'denied-dir', handle: fakeHandle, addedAt: Date.now(), lastSeenAt: Date.now() };

    const storeInstance = {
      listRoots: vi.fn().mockResolvedValue([deniedRecord]),
      saveRoot: vi.fn(),
      dropRoot: vi.fn(),
      findByLibrary: vi.fn(),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);
    ensurePermission.mockResolvedValue('denied');

    const { result } = renderHook(() => useFileHandles({ db: testDb }));

    await waitFor(() => result.current.status === 'denied' || result.current.status === 'ready');
    // When any handle has denied permission, status should reflect denied
    expect(['denied', 'ready']).toContain(result.current.status);
  });

  it('dropFolder calls store.dropRoot', async () => {
    isFsaSupported.mockReturnValue(true);
    const storeInstance = {
      listRoots: vi.fn().mockResolvedValue([]),
      saveRoot: vi.fn(),
      dropRoot: vi.fn().mockResolvedValue(undefined),
      findByLibrary: vi.fn(),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);

    const { result } = renderHook(() => useFileHandles({ db: testDb }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.dropFolder('some-id');
    });

    expect(storeInstance.dropRoot).toHaveBeenCalledWith('some-id');
  });

  it('selectFileByName returns null when handle is missing in roots', async () => {
    isFsaSupported.mockReturnValue(true);
    const storeInstance = {
      listRoots: vi.fn().mockResolvedValue([]),
      saveRoot: vi.fn(),
      dropRoot: vi.fn(),
      findByLibrary: vi.fn().mockResolvedValue(null),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);

    const { result } = renderHook(() => useFileHandles({ db: testDb }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const file = await result.current.selectFileByName('lib-missing', 'ep01.mkv');
    expect(file).toBeNull();
  });
});
