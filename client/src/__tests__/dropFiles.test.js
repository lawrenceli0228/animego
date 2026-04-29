import { describe, it, expect } from 'vitest';
import { flattenDropFiles } from '../utils/dropFiles';

function fileEntry(name, fullPath = '/' + name, fileFactory = null) {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file(success, fail) {
      try {
        const f = fileFactory ? fileFactory() : new File(['data'], name, { type: 'video/mp4' });
        success(f);
      } catch (e) { fail?.(e); }
    },
  };
}

function dirEntry(name, children, fullPath = '/' + name) {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader() {
      let drained = false;
      return {
        readEntries(success) {
          if (drained) success([]);
          else { drained = true; success(children); }
        },
      };
    },
  };
}

function dataTransfer(entries, opts = {}) {
  return {
    items: entries.map((entry) => ({
      webkitGetAsEntry: () => entry,
    })),
    files: opts.files || [],
  };
}

describe('flattenDropFiles', () => {
  it('returns empty array for null/undefined dataTransfer', async () => {
    expect(await flattenDropFiles(null)).toEqual([]);
    expect(await flattenDropFiles(undefined)).toEqual([]);
  });

  it('reads top-level files via webkitGetAsEntry', async () => {
    const dt = dataTransfer([fileEntry('a.mkv'), fileEntry('b.mkv')]);
    const files = await flattenDropFiles(dt);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name)).toEqual(['a.mkv', 'b.mkv']);
  });

  it('recurses into a dropped folder and yields all child files', async () => {
    const folder = dirEntry('Kaguya', [
      fileEntry('ep01.mp4', '/Kaguya/ep01.mp4'),
      fileEntry('ep02.mp4', '/Kaguya/ep02.mp4'),
    ]);
    const dt = dataTransfer([folder]);
    const files = await flattenDropFiles(dt);
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('ep01.mp4');
  });

  it('mixes a file and a folder in the same drop', async () => {
    const folder = dirEntry('Kaguya', [
      fileEntry('ep01.mp4', '/Kaguya/ep01.mp4'),
      fileEntry('ep02.mp4', '/Kaguya/ep02.mp4'),
    ]);
    const dt = dataTransfer([fileEntry('OshiNoKo.mkv', '/OshiNoKo.mkv'), folder]);
    const files = await flattenDropFiles(dt);
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.name).sort()).toEqual(['OshiNoKo.mkv', 'ep01.mp4', 'ep02.mp4']);
  });

  it('stamps webkitRelativePath from entry.fullPath for folder children', async () => {
    const folder = dirEntry('Kaguya', [fileEntry('ep01.mp4', '/Kaguya/ep01.mp4')]);
    const dt = dataTransfer([folder]);
    const files = await flattenDropFiles(dt);
    expect(files[0].webkitRelativePath).toBe('Kaguya/ep01.mp4');
  });

  it('falls back to dataTransfer.files when items API is missing', async () => {
    const f1 = new File(['x'], 'a.mkv');
    const f2 = new File(['y'], 'b.mkv');
    const dt = { files: [f1, f2] };
    const files = await flattenDropFiles(dt);
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(f1);
  });

  it('skips entries that fail to resolve a File object', async () => {
    const broken = {
      isFile: true,
      fullPath: '/broken.mkv',
      file(_success, fail) { fail?.(new Error('disk gone')); },
    };
    const dt = dataTransfer([broken, fileEntry('ok.mkv')]);
    const files = await flattenDropFiles(dt);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('ok.mkv');
  });

  // Symlink cycles cannot be detected via the Entries API. Without a depth
  // guard, a folder symlinked to itself would recurse until the tab OOMs.
  it('aborts traversal at MAX_DEPTH instead of recursing forever', async () => {
    let depth = 0;
    // Self-referential dir: createReader always returns [self].
    const cyclic = {
      isFile: false,
      isDirectory: true,
      fullPath: '/loop',
      createReader() {
        let drained = false;
        return {
          readEntries(success) {
            if (drained) { success([]); return; }
            drained = true;
            depth += 1;
            success([cyclic]); // recurse on the same node
          },
        };
      },
    };
    const dt = dataTransfer([cyclic]);
    const files = await flattenDropFiles(dt);
    expect(files).toEqual([]);
    // 12-deep guard means readEntries fires at most ~13 times, not infinitely.
    expect(depth).toBeLessThan(20);
  });
});
