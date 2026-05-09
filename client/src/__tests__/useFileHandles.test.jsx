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

vi.mock('../lib/library/handles/probeRoot.js', () => ({
  probeRootStatus: vi.fn().mockResolvedValue('ready'),
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
import { probeRootStatus } from '../lib/library/handles/probeRoot.js';
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

  it('negative: probe returns "denied" → global status reflects "denied" + libraryStatus map populated', async () => {
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
    probeRootStatus.mockResolvedValue('denied');

    const { result } = renderHook(() => useFileHandles({ db: testDb }));

    await waitFor(() => {
      expect(result.current.status).toBe('denied');
      expect(result.current.libraryStatus.get('lib-denied')).toBe('denied');
    });
  });

  it('disconnected: probe returns "disconnected" → global status stays "ready" but libraryStatus reports it', async () => {
    isFsaSupported.mockReturnValue(true);
    const fakeHandle = makeFakeHandle('usb-drive');
    const offlineRecord = { id: 'r-off', libraryId: 'lib-off', name: 'usb-drive', handle: fakeHandle, addedAt: Date.now(), lastSeenAt: Date.now() };

    const storeInstance = {
      listRoots: vi.fn().mockResolvedValue([offlineRecord]),
      saveRoot: vi.fn(),
      dropRoot: vi.fn(),
      findByLibrary: vi.fn(),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);
    probeRootStatus.mockResolvedValue('disconnected');

    const { result } = renderHook(() => useFileHandles({ db: testDb }));

    await waitFor(() => {
      // Global stays 'ready' so the library shell still renders. The
      // disconnected signal flows through libraryStatus.
      expect(result.current.status).toBe('ready');
      expect(result.current.libraryStatus.get('lib-off')).toBe('disconnected');
    });
  });

  it('mixed: ready + disconnected → status="ready", libraryStatus carries both', async () => {
    isFsaSupported.mockReturnValue(true);
    const okHandle = makeFakeHandle('ok-dir');
    const offHandle = makeFakeHandle('off-dir');
    const records = [
      { id: 'r-ok', libraryId: 'lib-ok', name: 'ok-dir', handle: okHandle, addedAt: 0, lastSeenAt: 0 },
      { id: 'r-off', libraryId: 'lib-off', name: 'off-dir', handle: offHandle, addedAt: 0, lastSeenAt: 0 },
    ];

    makeFileHandleStore.mockReturnValue({
      listRoots: vi.fn().mockResolvedValue(records),
      saveRoot: vi.fn(),
      dropRoot: vi.fn(),
      findByLibrary: vi.fn(),
    });
    probeRootStatus.mockImplementation(async (h) =>
      h === offHandle ? 'disconnected' : 'ready',
    );

    const { result } = renderHook(() => useFileHandles({ db: testDb }));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
      expect(result.current.libraryStatus.get('lib-ok')).toBe('ready');
      expect(result.current.libraryStatus.get('lib-off')).toBe('disconnected');
    });
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

  it('selectFileByName drills into macOS .mp4 directory bundle when getFileHandle throws TypeMismatchError', async () => {
    isFsaSupported.mockReturnValue(true);

    // Inner directory bundle: a "file" of size 5MB and one tiny sidecar
    const innerVideo = new File([new Uint8Array(5 * 1024 * 1024)], '001.mp4', { type: 'video/mp4' });
    const innerSidecar = new File([new Uint8Array(2048)], 'sidecar.mp4', { type: 'video/mp4' });
    const innerBundleHandle = {
      kind: 'directory',
      name: '[Group][Show][01][1080p].mp4',
      values: async function* () {
        yield {
          kind: 'file',
          name: '001.mp4',
          getFile: () => Promise.resolve(innerVideo),
        };
        yield {
          kind: 'file',
          name: 'sidecar.mp4',
          getFile: () => Promise.resolve(innerSidecar),
        };
      },
    };

    // Root handle: getFileHandle throws TypeMismatchError; getDirectoryHandle returns the bundle
    const typeMismatch = Object.assign(new Error('not a file'), { name: 'TypeMismatchError' });
    const fakeHandle = {
      kind: 'directory',
      name: 'root',
      queryPermission: vi.fn().mockResolvedValue('granted'),
      requestPermission: vi.fn().mockResolvedValue('granted'),
      getFileHandle: vi.fn().mockRejectedValue(typeMismatch),
      getDirectoryHandle: vi.fn().mockResolvedValue(innerBundleHandle),
    };

    const record = {
      id: 'r-bundle', libraryId: 'lib-bundle', name: 'root', handle: fakeHandle,
      addedAt: Date.now(), lastSeenAt: Date.now(),
    };
    const storeInstance = {
      listRoots: vi.fn().mockResolvedValue([record]),
      saveRoot: vi.fn(),
      dropRoot: vi.fn(),
      findByLibrary: vi.fn().mockResolvedValue(record),
    };
    makeFileHandleStore.mockReturnValue(storeInstance);
    ensurePermission.mockResolvedValue('granted');

    const { result } = renderHook(() => useFileHandles({ db: testDb }));
    await waitFor(() => expect(['ready', 'denied']).toContain(result.current.status));

    const file = await result.current.selectFileByName(
      'lib-bundle',
      '[Group][Show][01][1080p].mp4',
    );

    expect(file).toBe(innerVideo);
    expect(fakeHandle.getFileHandle).toHaveBeenCalledWith('[Group][Show][01][1080p].mp4');
    expect(fakeHandle.getDirectoryHandle).toHaveBeenCalledWith('[Group][Show][01][1080p].mp4');
  });
});
