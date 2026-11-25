import { describe, expect, test } from 'bun:test';
import { repickRoot, verifyPickedRoot, VERIFY_SAMPLE_SIZE } from './repickRoot.js';

// Re-picking replaces the stored handle of an existing library in place, so
// every series, episode and progress row keeps pointing at the same
// libraryId. Picking the wrong folder must change nothing.

/** A directory handle over a nested plain object: string = file, object = dir. */
function makeDir(name, tree) {
  const miss = (kind) => {
    const err = new Error(`${kind} not found`);
    err.name = 'NotFoundError';
    return err;
  };
  const mismatch = () => {
    const err = new Error('type mismatch');
    err.name = 'TypeMismatchError';
    return err;
  };
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(child) {
      const v = tree[child];
      if (v === undefined) throw miss('dir');
      if (typeof v !== 'object') throw mismatch();
      return makeDir(child, v);
    },
    async getFileHandle(child) {
      const v = tree[child];
      if (v === undefined) throw miss('file');
      if (typeof v === 'object') throw mismatch();
      return { kind: 'file', name: child };
    },
  };
}

const TREE = {
  'Show A': { 'a01.mkv': 'f', 'a02.mkv': 'f' },
  'Show B': { 'b01.mp4': 'f' },
  // macOS ExFAT bundle: a directory whose name carries the video extension.
  'bundle.mp4': { 'bundle.mp4': 'f' },
};
const REL_PATHS = ['Show A/a01.mkv', 'Show A/a02.mkv', 'Show B/b01.mp4', 'bundle.mp4'];

describe('verifyPickedRoot', () => {
  test('accepts the same folder', async () => {
    const r = await verifyPickedRoot(makeDir('anime', TREE), { expectedName: 'anime', relPaths: REL_PATHS });
    expect(r).toEqual({ ok: true, checked: 4, found: 4 });
  });

  test('rejects a folder with another name', async () => {
    const r = await verifyPickedRoot(makeDir('other', TREE), { expectedName: 'anime', relPaths: REL_PATHS });
    expect(r.ok).toBe(false);
  });

  test('accepts the folder after most of its files were deleted', async () => {
    // A download folder whose watched episodes were cleaned up: the rows
    // remain, the files do not. Refusing here would leave no way back.
    const r = await verifyPickedRoot(makeDir('anime', { 'Show B': { 'b01.mp4': 'f' } }), {
      expectedName: 'anime',
      relPaths: REL_PATHS,
    });
    expect(r).toEqual({ ok: true, checked: 4, found: 1 });
  });

  test('rejects a same-named folder holding none of the sampled files', async () => {
    const r = await verifyPickedRoot(makeDir('anime', { Other: { 'x.mkv': 'f' } }), {
      expectedName: 'anime',
      relPaths: REL_PATHS,
    });
    expect(r).toEqual({ ok: false, checked: 4, found: 0 });
  });

  test('looks up at most VERIFY_SAMPLE_SIZE files', async () => {
    const many = Array.from({ length: VERIFY_SAMPLE_SIZE + 5 }, (_, i) => `Show A/missing-${i}.mkv`);
    const r = await verifyPickedRoot(makeDir('anime', TREE), { expectedName: 'anime', relPaths: many });
    expect(r.checked).toBe(VERIFY_SAMPLE_SIZE);
  });

  test('accepts by name alone when the library has no files yet', async () => {
    const r = await verifyPickedRoot(makeDir('anime', {}), { expectedName: 'anime', relPaths: [] });
    expect(r.ok).toBe(true);
  });

  test('ignores path segments that would leave the folder', async () => {
    const r = await verifyPickedRoot(makeDir('anime', TREE), {
      expectedName: 'anime',
      relPaths: ['../Show A/a01.mkv', 'Show A/../Show B/b01.mp4'],
    });
    expect(r.found).toBe(0);
  });
});

function makeDeps({ pickResult, record = { id: 'h1', libraryId: 'lib1', name: 'anime' } } = {}) {
  const order = [];
  const saved = [];
  return {
    order,
    saved,
    deps: {
      libraryId: 'lib1',
      pick: async () => {
        order.push('pick');
        if (pickResult instanceof Error) throw pickResult;
        return pickResult;
      },
      findByLibrary: async (id) => {
        order.push('find');
        return id === 'lib1' ? record : null;
      },
      sampleRelPaths: async () => {
        order.push('sample');
        return REL_PATHS;
      },
      saveRoot: async (handle, libraryId) => {
        order.push('save');
        saved.push({ handle, libraryId });
        return { id: record.id, libraryId, handle };
      },
    },
  };
}

describe('repickRoot', () => {
  test('opens the picker before anything else, then replaces the handle under the same libraryId', async () => {
    const picked = makeDir('anime', TREE);
    const { deps, order, saved } = makeDeps({ pickResult: picked });
    const r = await repickRoot(deps);
    expect(r.status).toBe('rebound');
    expect(order[0]).toBe('pick');
    expect(saved).toEqual([{ handle: picked, libraryId: 'lib1' }]);
  });

  test('saves nothing when the picked folder does not match', async () => {
    const { deps, saved } = makeDeps({ pickResult: makeDir('other', TREE) });
    const r = await repickRoot(deps);
    expect(r.status).toBe('mismatch');
    expect(saved).toEqual([]);
  });

  test('reports a dismissed picker as cancelled', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const { deps, saved } = makeDeps({ pickResult: abort });
    expect((await repickRoot(deps)).status).toBe('cancelled');
    expect(saved).toEqual([]);
  });

  test('rethrows picker failures other than a dismissal', async () => {
    const { deps } = makeDeps({ pickResult: new Error('boom') });
    await expect(repickRoot(deps)).rejects.toThrow('boom');
  });

  test('saves nothing when the library has no stored folder', async () => {
    const { deps, saved } = makeDeps({ pickResult: makeDir('anime', TREE), record: null });
    expect((await repickRoot(deps)).status).toBe('missing');
    expect(saved).toEqual([]);
  });
});
