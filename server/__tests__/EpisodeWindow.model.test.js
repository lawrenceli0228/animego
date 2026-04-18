const EpisodeWindow = require('../models/EpisodeWindow');

describe('EpisodeWindow model', () => {
  it('requires anilistId, episode, and liveEndsAt', () => {
    const doc = new EpisodeWindow({});
    const err = doc.validateSync();
    expect(err.errors.anilistId).toBeDefined();
    expect(err.errors.episode).toBeDefined();
    expect(err.errors.liveEndsAt).toBeDefined();
  });

  it('accepts a complete doc', () => {
    const doc = new EpisodeWindow({
      anilistId: 1, episode: 1, liveEndsAt: new Date(),
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('has unique compound index on (anilistId, episode)', () => {
    const indexes = EpisodeWindow.schema.indexes();
    const unique = indexes.find(([spec, opts]) =>
      spec.anilistId === 1 && spec.episode === 1 && opts?.unique
    );
    expect(unique).toBeDefined();
  });

  it('has no TTL index — closed windows must persist', () => {
    const indexes = EpisodeWindow.schema.indexes();
    const ttl = indexes.find(([, opts]) => opts?.expireAfterSeconds !== undefined);
    expect(ttl).toBeUndefined();
  });

  it('does not enable timestamps (schema configured with timestamps: false)', () => {
    const paths = EpisodeWindow.schema.paths;
    expect(paths.createdAt).toBeUndefined();
    expect(paths.updatedAt).toBeUndefined();
  });
});
