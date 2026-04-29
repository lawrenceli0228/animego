import { collectFromHandle } from '../lib/library/handleTraversal/index.js';

/**
 * Build a fake FileSystemDirectoryHandle tree.
 * @param {Record<string, any>} spec - nested object; string values = file entries
 */
function makeDirHandle(name, spec) {
  const entries = Object.entries(spec).map(([key, val]) => {
    if (typeof val === 'string') {
      // File entry
      const file = new File([val], key);
      return {
        kind: 'file',
        name: key,
        getFile: async () => file,
      };
    }
    // Directory entry
    return {
      kind: 'directory',
      name: key,
      ...makeDirHandle(key, val),
    };
  });

  return {
    kind: 'directory',
    name,
    values: async function* () {
      for (const e of entries) yield e;
    },
  };
}

describe('collectFromHandle', () => {
  it('collects 3 video files from a tree', async () => {
    const handle = makeDirHandle('root', {
      'ep01.mkv': 'data',
      'ep02.mkv': 'data',
      sub: {
        'ep03.mp4': 'data',
      },
    });

    const result = await collectFromHandle(handle);
    expect(result).toHaveLength(3);
    const names = result.map(r => r.file.name);
    expect(names).toContain('ep01.mkv');
    expect(names).toContain('ep02.mkv');
    expect(names).toContain('ep03.mp4');
  });

  it('filters out non-video/non-subtitle files', async () => {
    const handle = makeDirHandle('root', {
      'ep01.mkv': 'data',
      'thumb.jpg': 'data',
      'readme.txt': 'data',
      'sub.srt': 'data',
    });

    const result = await collectFromHandle(handle);
    // mkv and srt should be collected, jpg and txt skipped
    const names = result.map(r => r.file.name);
    expect(names).toContain('ep01.mkv');
    expect(names).toContain('sub.srt');
    expect(names).not.toContain('thumb.jpg');
    expect(names).not.toContain('readme.txt');
  });

  it('includes relative paths', async () => {
    const handle = makeDirHandle('root', {
      season1: {
        'ep01.mkv': 'data',
      },
    });

    const result = await collectFromHandle(handle);
    expect(result[0].relPath).toBe('season1/ep01.mkv');
  });

  it('stops recursion at max depth 12', async () => {
    // Build a chain 14 levels deep
    function deepNest(depth, filename) {
      if (depth === 0) return { [filename]: 'data' };
      return { sub: deepNest(depth - 1, filename) };
    }
    const handle = makeDirHandle('root', deepNest(14, 'deep.mkv'));

    const result = await collectFromHandle(handle);
    // File is at depth 14 so it should NOT be reached (max 12)
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty directory', async () => {
    const handle = makeDirHandle('root', {});
    const result = await collectFromHandle(handle);
    expect(result).toHaveLength(0);
  });
});
