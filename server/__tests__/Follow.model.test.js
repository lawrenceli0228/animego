const mongoose = require('mongoose');
const Follow = require('../models/Follow');

describe('Follow model', () => {
  it('requires followerId and followeeId', () => {
    const doc = new Follow({});
    const err = doc.validateSync();
    expect(err.errors.followerId).toBeDefined();
    expect(err.errors.followeeId).toBeDefined();
  });

  it('accepts valid ObjectId references', () => {
    const doc = new Follow({
      followerId: new mongoose.Types.ObjectId(),
      followeeId: new mongoose.Types.ObjectId(),
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('has a unique index on (followerId, followeeId) to prevent dup follows', () => {
    const indexes = Follow.schema.indexes();
    const unique = indexes.find(([spec, opts]) =>
      spec.followerId === 1 && spec.followeeId === 1 && opts?.unique
    );
    expect(unique).toBeDefined();
  });

  it('has index on followeeId for follower-lookup queries', () => {
    const indexes = Follow.schema.indexes();
    const found = indexes.find(([spec]) =>
      spec.followeeId === 1 && Object.keys(spec).length === 1
    );
    expect(found).toBeDefined();
  });

  it('has timestamps enabled', () => {
    const paths = Follow.schema.paths;
    expect(paths.createdAt).toBeDefined();
    expect(paths.updatedAt).toBeDefined();
  });
});
