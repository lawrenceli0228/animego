import { describe, expect, test } from 'bun:test';
import { isCloneError, makeFileHandleStore } from './fileHandleStore.js';

// The invariant: a `put` that fails for a reason OTHER than "this value
// cannot be cloned" must reach the caller, and must not leave a stub behind.
//
// The stub exists so test doubles — whose fake handles carry function
// properties that structuredClone rejects — can still be persisted. It is a
// lossy record: the live handle survives only in a module-level cache that
// dies with the page. Writing one in response to a real storage failure
// silently converts "your watch folder is saved" into "your watch folder is
// saved until you close the tab", with nothing logged.

/** Minimal Dexie-shaped double: only what makeFileHandleStore actually calls. */
function makeDb({ failWith = null, failTimes = Infinity } = {}) {
  const rows = [];
  let putCalls = 0;

  const table = {
    async put(row) {
      putCalls += 1;
      if (failWith && putCalls <= failTimes) throw failWith;
      const at = rows.findIndex((r) => r.id === row.id);
      if (at === -1) rows.push(row);
      else rows[at] = row;
      return row.id;
    },
    where(field) {
      return {
        equals(value) {
          return { async first() { return rows.find((r) => r[field] === value) ?? null; } };
        },
      };
    },
    async toArray() { return [...rows]; },
    async delete(id) {
      const at = rows.findIndex((r) => r.id === id);
      if (at !== -1) rows.splice(at, 1);
    },
  };

  return { db: { fileHandles: table }, rows, putCalls: () => putCalls };
}

/** A handle shaped like the real thing, minus anything structuredClone hates. */
const cloneableHandle = { name: 'Anime', kind: 'directory' };

/** What a test double's handle looks like: a function property kills the clone. */
const uncloneableHandle = { name: 'Anime', kind: 'directory', queryPermission: () => 'granted' };

function domException(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe('isCloneError', () => {
  test('recognises the error directly', () => {
    expect(isCloneError(domException('DataCloneError'))).toBe(true);
  });

  test('recognises it wrapped by Dexie', () => {
    // Dexie re-throws the underlying DOMException on `.inner`; which of the
    // two carries the name depends on where the failure surfaced.
    expect(isCloneError({ name: 'DexieError', inner: { name: 'DataCloneError' } })).toBe(true);
  });

  test('is not fooled by other storage failures', () => {
    for (const name of [
      'NoModificationAllowedError',
      'QuotaExceededError',
      'InvalidStateError',
      'UnknownError',
      'AbortError',
    ]) {
      expect(isCloneError(domException(name))).toBe(false);
    }
  });

  test('handles non-objects', () => {
    for (const value of [null, undefined, 'DataCloneError', 42]) {
      expect(isCloneError(value)).toBe(false);
    }
  });
});

describe('saveRoot — the happy path is unchanged', () => {
  test('stores the live handle', async () => {
    const { db, rows } = makeDb();
    const store = makeFileHandleStore(db);

    const record = await store.saveRoot(cloneableHandle, 'lib-1');

    expect(record.libraryId).toBe('lib-1');
    expect(record.handle).toBe(cloneableHandle);
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe(cloneableHandle);
  });

  test('is idempotent per library', async () => {
    const { db, rows } = makeDb();
    const store = makeFileHandleStore(db);

    const first = await store.saveRoot(cloneableHandle, 'lib-1');
    const second = await store.saveRoot(cloneableHandle, 'lib-1');

    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });
});

describe('saveRoot — a clone failure still falls back to the stub', () => {
  test('writes a stub and returns the live handle', async () => {
    // Only the first put fails, mirroring the real sequence: the handle is
    // rejected, the stub is accepted.
    const { db, rows, putCalls } = makeDb({ failWith: domException('DataCloneError'), failTimes: 1 });
    const store = makeFileHandleStore(db);

    const record = await store.saveRoot(uncloneableHandle, 'lib-1');

    expect(putCalls()).toBe(2);
    expect(rows[0].handle).toEqual({ __stub: true, name: 'Anime' });
    // The caller still gets the live object for this session.
    expect(record.handle).toBe(uncloneableHandle);
  });

  test('a later read hydrates the live handle from the cache', async () => {
    const { db } = makeDb({ failWith: domException('DataCloneError'), failTimes: 1 });
    const store = makeFileHandleStore(db);

    await store.saveRoot(uncloneableHandle, 'lib-2');
    const found = await store.findByLibrary('lib-2');

    expect(found.handle).toBe(uncloneableHandle);
  });
});

describe('saveRoot — a real storage failure propagates', () => {
  // This is the behaviour change. Each of these used to be swallowed and
  // answered with a stub.
  const STORAGE_FAILURES = [
    'NoModificationAllowedError', // locked or read-only browser profile
    'QuotaExceededError', // disk or origin quota
    'InvalidStateError', // database closing
    'UnknownError', // corrupt IDB
  ];

  for (const name of STORAGE_FAILURES) {
    test(`${name} reaches the caller`, async () => {
      const { db } = makeDb({ failWith: domException(name) });
      const store = makeFileHandleStore(db);

      await expect(store.saveRoot(cloneableHandle, 'lib-1')).rejects.toThrow(name);
    });

    test(`${name} does not leave a stub behind`, async () => {
      // The damaging half. A stub written here looks like a saved watch
      // folder and is gone on the next page load.
      const { db, rows, putCalls } = makeDb({ failWith: domException(name) });
      const store = makeFileHandleStore(db);

      await store.saveRoot(cloneableHandle, 'lib-1').catch(() => {});

      expect(putCalls()).toBe(1); // no retry
      expect(rows).toHaveLength(0);
    });
  }

  test('a transient failure is still not treated as a clone failure', async () => {
    // The nastiest ordering: the first put fails for a real reason and the
    // second would succeed. The old code persisted a stub here and returned
    // as if all was well.
    const { db, rows, putCalls } = makeDb({
      failWith: domException('NoModificationAllowedError'),
      failTimes: 1,
    });
    const store = makeFileHandleStore(db);

    await expect(store.saveRoot(cloneableHandle, 'lib-1')).rejects.toThrow(
      'NoModificationAllowedError',
    );
    expect(putCalls()).toBe(1);
    expect(rows).toHaveLength(0);
  });
});
