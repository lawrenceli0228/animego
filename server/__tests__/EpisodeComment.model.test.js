const mongoose = require('mongoose');
const EpisodeComment = require('../models/EpisodeComment');

describe('EpisodeComment model', () => {
  const base = () => ({
    anilistId: 1,
    episode: 1,
    userId: new mongoose.Types.ObjectId(),
    username: 'alice',
    content: 'hello',
  });

  it('requires core fields', () => {
    const doc = new EpisodeComment({});
    const err = doc.validateSync();
    expect(err.errors.anilistId).toBeDefined();
    expect(err.errors.episode).toBeDefined();
    expect(err.errors.userId).toBeDefined();
    expect(err.errors.username).toBeDefined();
    expect(err.errors.content).toBeDefined();
  });

  it('validates a complete doc', () => {
    const doc = new EpisodeComment(base());
    expect(doc.validateSync()).toBeUndefined();
  });

  it('rejects content over 500 characters', () => {
    const doc = new EpisodeComment({ ...base(), content: 'a'.repeat(501) });
    expect(doc.validateSync().errors.content).toBeDefined();
  });

  it('accepts content at exactly 500 characters', () => {
    const doc = new EpisodeComment({ ...base(), content: 'a'.repeat(500) });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('defaults parentId and replyToUsername to null', () => {
    const doc = new EpisodeComment(base());
    expect(doc.parentId).toBeNull();
    expect(doc.replyToUsername).toBeNull();
  });

  it('accepts a parentId ObjectId for replies', () => {
    const parent = new mongoose.Types.ObjectId();
    const doc = new EpisodeComment({
      ...base(), parentId: parent, replyToUsername: 'bob',
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(String(doc.parentId)).toBe(String(parent));
  });

  it('has compound index for (anilistId, episode) fetch', () => {
    const indexes = EpisodeComment.schema.indexes();
    const found = indexes.find(([spec]) =>
      spec.anilistId === 1 && spec.episode === 1
    );
    expect(found).toBeDefined();
  });

  it('has index on parentId for reply queries', () => {
    const indexes = EpisodeComment.schema.indexes();
    const found = indexes.find(([spec]) =>
      spec.parentId === 1 && Object.keys(spec).length === 1
    );
    expect(found).toBeDefined();
  });
});
