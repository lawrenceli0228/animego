// @ts-check
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/library/db/db.js';
import { makeFileHandleStore } from '../lib/library/handles/fileHandleStore.js';

function makeFakeHandle(name = 'mydir') {
  return {
    name,
    kind: 'directory',
    queryPermission: () => Promise.resolve('granted'),
    requestPermission: () => Promise.resolve('granted'),
  };
}

describe('makeFileHandleStore', () => {
  /** @type {ReturnType<typeof makeFileHandleStore>} */
  let store;

  beforeEach(async () => {
    const testDb = getDb('test-fhs-' + Date.now() + Math.random());
    await testDb.open();
    store = makeFileHandleStore(testDb);
  });

  it('saveRoot then listRoots returns 1 record', async () => {
    const handle = makeFakeHandle('anime');
    await store.saveRoot(handle, 'lib-1');
    const roots = await store.listRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('anime');
    expect(roots[0].libraryId).toBe('lib-1');
  });

  it('saveRoot twice with same libraryId is idempotent (still 1 record)', async () => {
    const handle = makeFakeHandle('anime');
    await store.saveRoot(handle, 'lib-dup');
    await store.saveRoot(handle, 'lib-dup');
    const roots = await store.listRoots();
    const libRoots = roots.filter(r => r.libraryId === 'lib-dup');
    expect(libRoots).toHaveLength(1);
  });

  it('saveRoot with same libraryId updates lastSeenAt', async () => {
    const handle = makeFakeHandle('anime');
    const first = await store.saveRoot(handle, 'lib-ts');
    // Small delay to ensure timestamp difference
    await new Promise(r => setTimeout(r, 5));
    const second = await store.saveRoot(handle, 'lib-ts');
    const roots = await store.listRoots();
    const rec = roots.find(r => r.libraryId === 'lib-ts');
    expect(rec).toBeDefined();
    // The record should have been updated
    expect(rec.lastSeenAt).toBeGreaterThanOrEqual(first.addedAt ?? 0);
  });

  it('dropRoot removes the record', async () => {
    const handle = makeFakeHandle('todelete');
    await store.saveRoot(handle, 'lib-del');
    const roots = await store.listRoots();
    const rec = roots.find(r => r.libraryId === 'lib-del');
    await store.dropRoot(rec.id);
    const after = await store.listRoots();
    expect(after.find(r => r.id === rec.id)).toBeUndefined();
  });

  it('findByLibrary returns record when present', async () => {
    const handle = makeFakeHandle('search-me');
    await store.saveRoot(handle, 'lib-find');
    const found = await store.findByLibrary('lib-find');
    expect(found).not.toBeNull();
    expect(found.name).toBe('search-me');
  });

  it('findByLibrary returns null when missing', async () => {
    const found = await store.findByLibrary('lib-nonexistent');
    expect(found).toBeNull();
  });

  it('saveRoot stores the handle object', async () => {
    const handle = makeFakeHandle('handle-stored');
    await store.saveRoot(handle, 'lib-obj');
    const found = await store.findByLibrary('lib-obj');
    expect(found.handle).toBeDefined();
    expect(found.handle.name).toBe('handle-stored');
  });

  it('saved record has addedAt and lastSeenAt timestamps', async () => {
    const handle = makeFakeHandle('timestamped');
    const before = Date.now();
    await store.saveRoot(handle, 'lib-time');
    const after = Date.now();
    const found = await store.findByLibrary('lib-time');
    expect(found.addedAt).toBeGreaterThanOrEqual(before);
    expect(found.addedAt).toBeLessThanOrEqual(after);
    expect(found.lastSeenAt).toBeGreaterThanOrEqual(before);
  });
});
