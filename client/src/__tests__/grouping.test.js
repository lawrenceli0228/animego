import { describe, it, expect } from 'vitest';
import { groupByFolder } from '../lib/library/grouping';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal EpisodeItem factory. Only the fields groupByFolder actually reads.
 * @param {Partial<import('../lib/library/types').EpisodeItem>} overrides
 * @returns {import('../lib/library/types').EpisodeItem}
 */
function item(overrides) {
  const fileName = overrides.fileName ?? 'ep01.mkv';
  return {
    fileId: overrides.fileId ?? fileName,
    file: null,
    fileName,
    relativePath: overrides.relativePath ?? fileName,
    episode: overrides.episode !== undefined ? overrides.episode : 1,
    parsedKind: overrides.parsedKind ?? 'main',
    ...overrides,
  };
}

// ── test cases ────────────────────────────────────────────────────────────────

describe('groupByFolder', () => {
  // 1. Empty input
  it('returns [] for empty input', () => {
    expect(groupByFolder([])).toEqual([]);
  });

  // 2. Single root-level file (no slash in relativePath)
  it('places a flat-dropped file in __root__ group with sentinel label', () => {
    const result = groupByFolder([item({ fileName: 'movie.mkv', relativePath: 'movie.mkv' })]);
    expect(result).toHaveLength(1);
    const [g] = result;
    expect(g.groupKey).toBe('__root__');
    // grouping.js stays locale-free: UI translates __root__ → "(根)" / "(root)"
    expect(g.label).toBe('__root__');
    expect(g.items).toHaveLength(1);
    expect(typeof g.id).toBe('string');
    expect(g.id.length).toBeGreaterThan(0);
  });

  // 2b. id is deterministic from groupKey (pure function contract)
  it('produces deterministic ids derived from groupKey', () => {
    const a = groupByFolder([item({ fileName: 'x.mkv', relativePath: 'Show/x.mkv', episode: 1 })]);
    const b = groupByFolder([item({ fileName: 'x.mkv', relativePath: 'Show/x.mkv', episode: 1 })]);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toContain('Show');
  });

  // 3. All files share one folder → one group, sorted episode asc
  it('groups all files under a single folder and sorts by episode asc', () => {
    const items = [
      item({ fileName: 'ep03.mkv', relativePath: 'Show/ep03.mkv', episode: 3 }),
      item({ fileName: 'ep01.mkv', relativePath: 'Show/ep01.mkv', episode: 1 }),
      item({ fileName: 'ep02.mkv', relativePath: 'Show/ep02.mkv', episode: 2 }),
    ];
    const result = groupByFolder(items);
    expect(result).toHaveLength(1);
    const [g] = result;
    expect(g.groupKey).toBe('Show');
    expect(g.label).toBe('Show');
    expect(g.sortMode).toBe('episode');
    expect(g.hasAmbiguity).toBe(false);
    expect(g.items.map((i) => i.episode)).toEqual([1, 2, 3]);
  });

  // 4. Two folders — larger group comes first, groupKeys differ
  it('returns two distinct groups for Show/S1 and Show/SPs, larger group first', () => {
    const s1 = [
      item({ fileName: 'ep01.mkv', relativePath: 'Show/S1/ep01.mkv', episode: 1 }),
      item({ fileName: 'ep02.mkv', relativePath: 'Show/S1/ep02.mkv', episode: 2 }),
      item({ fileName: 'ep03.mkv', relativePath: 'Show/S1/ep03.mkv', episode: 3 }),
    ];
    const sps = [
      item({ fileName: 'sp01.mkv', relativePath: 'Show/SPs/sp01.mkv', episode: 1, parsedKind: 'sp' }),
    ];
    const result = groupByFolder([...sps, ...s1]);
    expect(result).toHaveLength(2);
    expect(result[0].groupKey).toBe('Show/S1');
    expect(result[1].groupKey).toBe('Show/SPs');
    expect(result[0].items).toHaveLength(3);
    expect(result[1].items).toHaveLength(1);
  });

  // 5. Same folder, mixed kind with same episode number → hasAmbiguity + sortMode='alpha'
  it('sets hasAmbiguity=true and sortMode=alpha when same episode has different kinds', () => {
    const items = [
      item({ fileName: 'ep05.mkv',    relativePath: 'Show/ep05.mkv',    episode: 5, parsedKind: 'main' }),
      item({ fileName: 'sp05.mkv',    relativePath: 'Show/sp05.mkv',    episode: 5, parsedKind: 'sp' }),
    ];
    const [g] = groupByFolder(items);
    expect(g.hasAmbiguity).toBe(true);
    expect(g.sortMode).toBe('alpha');
  });

  // 6. Duplicate folder names under different parents → two distinct groups
  it('distinguishes A/Show and B/Show as separate groups (full-path keys)', () => {
    const items = [
      item({ fileName: 'ep01.mkv', relativePath: 'A/Show/ep01.mkv', episode: 1 }),
      item({ fileName: 'ep01.mkv', relativePath: 'B/Show/ep01.mkv', episode: 1 }),
    ];
    const result = groupByFolder(items);
    expect(result).toHaveLength(2);
    const keys = result.map((g) => g.groupKey).sort();
    expect(keys).toEqual(['A/Show', 'B/Show']);
  });

  // 7. v3.1: Flat drop of 5+ files → 5 singleton groups (root-dir cluster exception)
  // Replaces the v3 behavior of one mega __root__ group; prevents Stage 2 from
  // mashing 7 different anime into a single cluster (T7 验真).
  it('splits multi-file __root__ into singleton groups (v3.1 root-dir exception)', () => {
    const files = ['a.mkv', 'b.mkv', 'c.mkv', 'd.mkv', 'e.mkv'].map((name, i) =>
      item({ fileName: name, relativePath: name, episode: i + 1 }),
    );
    const result = groupByFolder(files);
    expect(result).toHaveLength(5);
    for (const g of result) {
      expect(g.items).toHaveLength(1);
      expect(g.groupKey.startsWith('__root__/')).toBe(true);
    }
    // each singleton group's label is the file name
    const labels = result.map((g) => g.label).sort();
    expect(labels).toEqual(['a.mkv', 'b.mkv', 'c.mkv', 'd.mkv', 'e.mkv']);
  });

  // 7b. v3.1: single root file keeps the original __root__ sentinel
  it('preserves the original __root__ sentinel for a single root file', () => {
    const result = groupByFolder([item({ fileName: 'lonely.mkv', relativePath: 'lonely.mkv', episode: 1 })]);
    expect(result).toHaveLength(1);
    expect(result[0].groupKey).toBe('__root__');
  });

  // 7c. v3.1: root-dir exception applies even when files would otherwise share an episode
  it('splits root files even when episodes collide (different anime, same ep #)', () => {
    const files = [
      item({ fileName: 'Heavenly Delusion E01.mkv', relativePath: 'Heavenly Delusion E01.mkv', episode: 1, parsedTitle: 'Heavenly Delusion' }),
      item({ fileName: 'Jigokuraku E01.mkv', relativePath: 'Jigokuraku E01.mkv', episode: 1, parsedTitle: 'Jigokuraku' }),
      item({ fileName: 'Mercury E01.mp4', relativePath: 'Mercury E01.mp4', episode: 1, parsedTitle: 'Witch from Mercury' }),
    ];
    const result = groupByFolder(files);
    expect(result).toHaveLength(3);
    expect(result.every((g) => g.items.length === 1)).toBe(true);
  });

  // 8. OVA-only group → uniform kind, no ambiguity, sortMode='episode'
  it('does not flag ambiguity for a uniform ova-only group', () => {
    const items = [
      item({ fileName: 'ova02.mkv', relativePath: 'OVAs/ova02.mkv', episode: 2, parsedKind: 'ova' }),
      item({ fileName: 'ova01.mkv', relativePath: 'OVAs/ova01.mkv', episode: 1, parsedKind: 'ova' }),
    ];
    const [g] = groupByFolder(items);
    expect(g.hasAmbiguity).toBe(false);
    expect(g.sortMode).toBe('episode');
    expect(g.items[0].episode).toBe(1);
    expect(g.items[1].episode).toBe(2);
  });

  // 9. Stable sort: two items with episode=null keep input order
  it('keeps insertion order for items that both have episode=null', () => {
    const a = item({ fileName: 'aaa.mkv', relativePath: 'Show/aaa.mkv', episode: null });
    const b = item({ fileName: 'bbb.mkv', relativePath: 'Show/bbb.mkv', episode: null });
    // Input order is a, b
    const [g] = groupByFolder([a, b]);
    // episode=null → Infinity, so both are equal in episode; tiebreak by fileName
    // 'aaa.mkv' < 'bbb.mkv' alphabetically → a first
    expect(g.items[0].fileName).toBe('aaa.mkv');
    expect(g.items[1].fileName).toBe('bbb.mkv');
  });

  // 10. main has gaps filled by sp/ova (main ep 1,3 + sp ep 2) → ambiguity triggers
  it('sets hasAmbiguity=true when main has gaps and sp fills those numbers', () => {
    const items = [
      item({ fileName: 'main01.mkv', relativePath: 'Show/main01.mkv', episode: 1, parsedKind: 'main' }),
      item({ fileName: 'sp02.mkv',   relativePath: 'Show/sp02.mkv',   episode: 2, parsedKind: 'sp' }),
      item({ fileName: 'main03.mkv', relativePath: 'Show/main03.mkv', episode: 3, parsedKind: 'main' }),
    ];
    const [g] = groupByFolder(items);
    expect(g.hasAmbiguity).toBe(true);
    expect(g.sortMode).toBe('alpha');
  });
});
