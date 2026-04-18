const mongoose = require('mongoose');
const Danmaku = require('../models/Danmaku');

describe('Danmaku model', () => {
  const base = () => ({
    anilistId: 1,
    episode: 1,
    userId: new mongoose.Types.ObjectId(),
    username: 'alice',
    content: 'hi',
    liveEndsAt: new Date(Date.now() + 60_000),
  });

  it('requires all core fields', () => {
    const doc = new Danmaku({});
    const err = doc.validateSync();
    expect(err.errors.anilistId).toBeDefined();
    expect(err.errors.episode).toBeDefined();
    expect(err.errors.userId).toBeDefined();
    expect(err.errors.username).toBeDefined();
    expect(err.errors.content).toBeDefined();
    expect(err.errors.liveEndsAt).toBeDefined();
  });

  it('accepts a valid doc', () => {
    const doc = new Danmaku(base());
    expect(doc.validateSync()).toBeUndefined();
  });

  it('rejects content over 50 characters', () => {
    const doc = new Danmaku({ ...base(), content: 'x'.repeat(51) });
    const err = doc.validateSync();
    expect(err.errors.content).toBeDefined();
  });

  it('accepts content at exactly 50 characters', () => {
    const doc = new Danmaku({ ...base(), content: 'x'.repeat(50) });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('has TTL index to expire documents after ~1 year', () => {
    const indexes = Danmaku.schema.indexes();
    const ttl = indexes.find(([, opts]) => opts?.expireAfterSeconds);
    expect(ttl).toBeDefined();
    expect(ttl[1].expireAfterSeconds).toBe(365 * 24 * 3600);
  });

  it('has index for fetching-by-episode queries', () => {
    const indexes = Danmaku.schema.indexes();
    const found = indexes.find(([spec]) =>
      spec.anilistId === 1 && spec.episode === 1 && spec.createdAt === 1
    );
    expect(found).toBeDefined();
  });
});
