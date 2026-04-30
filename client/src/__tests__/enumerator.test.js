import { describe, it, expect } from 'vitest';
import { enumerate, enumerateAll, _internal } from '../lib/library/enumerator.js';

/**
 * Build a fake FileSystemDirectoryHandle tree.
 *
 * spec format:
 *   - string value → file with that string as content
 *   - { _file: bytes, _size?: n, _name?: ovr } → file with explicit size
 *   - any other object → directory
 *
 * @param {string} name
 * @param {Record<string, any>} spec
 */
function makeDirHandle(name, spec) {
  const entries = Object.entries(spec).map(([key, val]) => {
    if (typeof val === 'string') {
      const file = new File([val], key);
      return {
        kind: 'file',
        name: key,
        getFile: async () => file,
      };
    }
    if (val && typeof val === 'object' && '_file' in val) {
      // explicit-size file: pad bytes to reach target size cheaply
      const size = val._size ?? (val._file?.length ?? 0);
      const padding = new Uint8Array(Math.max(0, size - (val._file?.length ?? 0)));
      const file = new File([val._file ?? '', padding], key);
      return {
        kind: 'file',
        name: key,
        getFile: async () => file,
      };
    }
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

const BIG = '_'.repeat(_internal.MIN_VIDEO_SIZE + 1024);
const TINY = '_'.repeat(2048);

describe('enumerator (v3.1 Stage 0)', () => {
  // ── Noise filter ─────────────────────────────────────────────────────────────

  it('skips AppleDouble `._*` files', async () => {
    const root = makeDirHandle('root', {
      'ep01.mkv': BIG,
      '._ep01.mkv': TINY,
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toBe('ep01.mkv');
  });

  it('skips .DS_Store / Thumbs.db / desktop.ini', async () => {
    const root = makeDirHandle('root', {
      'ep01.mkv': BIG,
      '.DS_Store': 'mac garbage',
      'Thumbs.db': 'win garbage',
      'desktop.ini': 'win garbage',
    });
    const out = await enumerateAll(root);
    const names = out.map(r => r.file.name);
    expect(names).toEqual(['ep01.mkv']);
  });

  // ── Size threshold ──────────────────────────────────────────────────────────

  it('skips video files smaller than 1MB', async () => {
    const root = makeDirHandle('root', {
      'real.mkv': BIG,
      'thumb.mp4': TINY,
    });
    const out = await enumerateAll(root);
    const names = out.map(r => r.file.name);
    expect(names).toContain('real.mkv');
    expect(names).not.toContain('thumb.mp4');
  });

  it('does not size-gate subtitles', async () => {
    const root = makeDirHandle('root', {
      'ep01.mkv': BIG,
      'ep01.srt': '1\n00:00:00,000 --> 00:00:01,000\nhi',
    });
    const out = await enumerateAll(root);
    const subs = out.filter(r => r.kind === 'subtitle');
    expect(subs).toHaveLength(1);
    expect(subs[0].file.name).toBe('ep01.srt');
  });

  // ── .mp4-package drill (macOS ExFAT) ────────────────────────────────────────

  it('drills into a directory whose name has a video ext (depth 0) and yields the largest matching child', async () => {
    const root = makeDirHandle('root', {
      'movie.mp4': {
        // package: directory shaped like a .mp4
        'real.mp4': BIG,
        '._real.mp4': TINY,
        'sidecar.mp4': '_'.repeat(_internal.MIN_VIDEO_SIZE / 2),
      },
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toBe('movie.mp4');
    expect(out[0].file.size).toBeGreaterThan(_internal.MIN_VIDEO_SIZE);
  });

  it('drills .mp4-package one level deep at depth 1 too', async () => {
    const root = makeDirHandle('root', {
      Show: {
        'ep01.mp4': {
          'real.mp4': BIG,
        },
      },
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toBe('Show/ep01.mp4');
    expect(out[0].depth).toBe(1);
  });

  it('does not drill into .mp4-dir whose only child is below 1MB', async () => {
    const root = makeDirHandle('root', {
      'fake.mp4': {
        'inner.mp4': TINY,
      },
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(0);
  });

  // ── NFC normalization ──────────────────────────────────────────────────────

  it('NFC-normalizes relPath at the boundary', async () => {
    // NFD form of "é" is "e" + U+0301 (combining acute). Compose it via NFD output.
    const nfd = 'caf\u0065\u0301.mkv'; // "café.mkv" in NFD form
    const nfc = nfd.normalize('NFC'); // "café.mkv" in NFC form (single codepoint)
    expect(nfd).not.toBe(nfc);

    const root = makeDirHandle('root', {
      [nfd]: BIG,
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toBe(nfc);
  });

  // ── Depth limit ────────────────────────────────────────────────────────────

  it('cuts off recursion at depth >= 3', async () => {
    // root → L1 → L2 → L3 → L4 → ep.mkv (file at depth 4 — never reached)
    const root = makeDirHandle('root', {
      L1: {
        L2: {
          L3: {
            L4: {
              'too-deep.mkv': BIG,
            },
          },
        },
      },
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(0);
  });

  it('keeps files at depth 3 (parent at depth 2)', async () => {
    const root = makeDirHandle('root', {
      L1: {
        L2: {
          L3: {
            'ok.mkv': BIG,
          },
        },
      },
    });
    const out = await enumerateAll(root);
    expect(out).toHaveLength(1);
    expect(out[0].depth).toBe(3);
  });

  // ── enumerate yields lazily ────────────────────────────────────────────────

  it('enumerate is an async iterable that yields one item at a time', async () => {
    const root = makeDirHandle('root', {
      'a.mkv': BIG,
      'b.mkv': BIG,
    });
    const seen = [];
    for await (const item of enumerate(root)) {
      seen.push(item.relPath);
    }
    expect(seen.sort()).toEqual(['a.mkv', 'b.mkv']);
  });

  // ── T7-shaped fixture replay (smoke) ────────────────────────────────────────

  it('replays a T7-shaped tree and yields only real videos', async () => {
    const root = makeDirHandle('root', {
      // .mp4-package directories
      '[Airota] Heavenly Delusion E01.mp4': {
        '[Airota] Heavenly Delusion E01.mp4': BIG,
        '._[Airota] Heavenly Delusion E01.mp4': TINY,
      },
      // root scattered files (different anime)
      'Jigokuraku.E07.WEBRip.1080p.x265.mkv': BIG,
      'GUNDAM_PROLOGUE_1080p.mp4': BIG,
      // AppleDouble noise
      '._Jigokuraku.E07.WEBRip.1080p.x265.mkv': TINY,
      // Sidecar noise
      '.DS_Store': 'mac',
      // Series folder
      'Akiba Maid Sensou': {
        'Akiba_Maid_War_E01_1080p.mkv': BIG,
        'Akiba_Maid_War_E02_1080p.mkv': BIG,
        '._Akiba_Maid_War_E01_1080p.mkv': TINY,
      },
      // Tiny fake video
      'thumbs.mp4': TINY,
    });

    const out = await enumerateAll(root);
    const paths = new Set(out.map(r => r.relPath));
    expect(paths).toEqual(new Set([
      '[Airota] Heavenly Delusion E01.mp4',
      'Akiba Maid Sensou/Akiba_Maid_War_E01_1080p.mkv',
      'Akiba Maid Sensou/Akiba_Maid_War_E02_1080p.mkv',
      'GUNDAM_PROLOGUE_1080p.mp4',
      'Jigokuraku.E07.WEBRip.1080p.x265.mkv',
    ]));
    expect(out).toHaveLength(5);
  });
});

describe('enumerator internals', () => {
  it('isNoise catches ._*, .DS_Store, Thumbs.db, desktop.ini', () => {
    expect(_internal.isNoise('._foo.mp4')).toBe(true);
    expect(_internal.isNoise('.DS_Store')).toBe(true);
    expect(_internal.isNoise('Thumbs.db')).toBe(true);
    expect(_internal.isNoise('desktop.ini')).toBe(true);
    expect(_internal.isNoise('foo.mp4')).toBe(false);
    expect(_internal.isNoise('.hidden')).toBe(false); // generic dotfiles ok
  });

  it('hasVideoExt is case-insensitive and covers MKV/MP4/etc.', () => {
    expect(_internal.hasVideoExt('foo.MKV')).toBe(true);
    expect(_internal.hasVideoExt('foo.mp4')).toBe(true);
    expect(_internal.hasVideoExt('foo.RMVB')).toBe(true);
    expect(_internal.hasVideoExt('foo.txt')).toBe(false);
  });
});
