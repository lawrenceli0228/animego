const AnimeCache = require('../models/AnimeCache');

describe('AnimeCache model', () => {
  it('requires anilistId', () => {
    const doc = new AnimeCache({});
    const err = doc.validateSync();
    expect(err.errors.anilistId).toBeDefined();
  });

  it('validates a minimal doc with just anilistId', () => {
    const doc = new AnimeCache({ anilistId: 42 });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('auto-fills cachedAt default', () => {
    const before = Date.now();
    const doc = new AnimeCache({ anilistId: 42 });
    const after = Date.now();
    expect(doc.cachedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.cachedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('defaults bangumiVersion to 0', () => {
    const doc = new AnimeCache({ anilistId: 42 });
    expect(doc.bangumiVersion).toBe(0);
  });

  it('defaults adminFlag to null and restricts values', () => {
    const doc = new AnimeCache({ anilistId: 42 });
    expect(doc.adminFlag).toBeNull();

    const ok = new AnimeCache({ anilistId: 43, adminFlag: 'needs-review' });
    expect(ok.validateSync()).toBeUndefined();

    const bad = new AnimeCache({ anilistId: 44, adminFlag: 'invalid' });
    expect(bad.validateSync().errors.adminFlag).toBeDefined();
  });

  it('stores relations as a subdocument array', () => {
    const doc = new AnimeCache({
      anilistId: 1,
      relations: [
        { anilistId: 2, relationType: 'SEQUEL', title: 'Part 2', coverImageUrl: 'x', format: 'TV' },
      ],
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.relations).toHaveLength(1);
    expect(doc.relations[0].anilistId).toBe(2);
  });

  it('has unique index on anilistId', () => {
    // anilistId field has unique: true — check via schemaType
    expect(AnimeCache.schema.paths.anilistId.options.unique).toBe(true);
  });

  it('has seasonal index (season, seasonYear)', () => {
    const indexes = AnimeCache.schema.indexes();
    const found = indexes.find(([spec]) =>
      spec.season === 1 && spec.seasonYear === 1
    );
    expect(found).toBeDefined();
  });

  it('has text index for title search', () => {
    const indexes = AnimeCache.schema.indexes();
    const textIdx = indexes.find(([spec]) =>
      spec.titleChinese === 'text' || spec.titleRomaji === 'text'
    );
    expect(textIdx).toBeDefined();
  });

  it('accepts titleChinese and bgmId defaults of null', () => {
    const doc = new AnimeCache({ anilistId: 1 });
    expect(doc.titleChinese).toBeNull();
    expect(doc.bgmId).toBeNull();
  });

  it('genres field accepts array of strings', () => {
    const doc = new AnimeCache({ anilistId: 1, genres: ['Action', 'Drama'] });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.genres).toEqual(['Action', 'Drama']);
  });
});
