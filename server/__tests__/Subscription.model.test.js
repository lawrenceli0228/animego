const mongoose = require('mongoose');
const Subscription = require('../models/Subscription');

describe('Subscription model', () => {
  describe('schema validation', () => {
    it('requires userId, anilistId, and status', () => {
      const doc = new Subscription({});
      const err = doc.validateSync();
      expect(err.errors.userId).toBeDefined();
      expect(err.errors.anilistId).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });

    it('rejects status not in the enum', () => {
      const doc = new Subscription({
        userId: new mongoose.Types.ObjectId(),
        anilistId: 1,
        status: 'bad-status',
      });
      const err = doc.validateSync();
      expect(err.errors.status).toBeDefined();
    });

    it('accepts all four valid statuses', () => {
      for (const status of ['watching', 'completed', 'plan_to_watch', 'dropped']) {
        const doc = new Subscription({
          userId: new mongoose.Types.ObjectId(), anilistId: 1, status,
        });
        expect(doc.validateSync()).toBeUndefined();
      }
    });

    it('defaults currentEpisode to 0', () => {
      const doc = new Subscription({
        userId: new mongoose.Types.ObjectId(), anilistId: 1, status: 'watching',
      });
      expect(doc.currentEpisode).toBe(0);
    });

    it('rejects negative currentEpisode', () => {
      const doc = new Subscription({
        userId: new mongoose.Types.ObjectId(), anilistId: 1, status: 'watching',
        currentEpisode: -1,
      });
      const err = doc.validateSync();
      expect(err.errors.currentEpisode).toBeDefined();
    });

    it('rejects score below 1 or above 10', () => {
      const below = new Subscription({
        userId: new mongoose.Types.ObjectId(), anilistId: 1, status: 'completed', score: 0,
      });
      const above = new Subscription({
        userId: new mongoose.Types.ObjectId(), anilistId: 1, status: 'completed', score: 11,
      });
      expect(below.validateSync().errors.score).toBeDefined();
      expect(above.validateSync().errors.score).toBeDefined();
    });

    it('accepts score between 1 and 10 inclusive', () => {
      for (const score of [1, 5, 10]) {
        const doc = new Subscription({
          userId: new mongoose.Types.ObjectId(), anilistId: 1, status: 'completed', score,
        });
        expect(doc.validateSync()).toBeUndefined();
      }
    });

    it('defaults score and lastWatchedAt to null', () => {
      const doc = new Subscription({
        userId: new mongoose.Types.ObjectId(), anilistId: 1, status: 'watching',
      });
      expect(doc.score).toBeNull();
      expect(doc.lastWatchedAt).toBeNull();
    });
  });

  describe('indexes', () => {
    it('has compound unique index on (userId, anilistId)', () => {
      const indexes = Subscription.schema.indexes();
      const unique = indexes.find(([spec, opts]) =>
        spec.userId === 1 && spec.anilistId === 1 && opts?.unique
      );
      expect(unique).toBeDefined();
    });

    it('has index for (userId, status) query', () => {
      const indexes = Subscription.schema.indexes();
      const found = indexes.find(([spec]) => spec.userId === 1 && spec.status === 1);
      expect(found).toBeDefined();
    });
  });

  describe('timestamps', () => {
    it('has createdAt and updatedAt fields in schema', () => {
      const paths = Subscription.schema.paths;
      expect(paths.createdAt).toBeDefined();
      expect(paths.updatedAt).toBeDefined();
    });
  });
});
