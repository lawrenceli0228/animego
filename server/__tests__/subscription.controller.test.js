const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Subscription', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findOneAndDelete: jest.fn(),
}));

jest.mock('../models/AnimeCache', () => ({
  find: jest.fn(),
}));

jest.mock('../services/anilist.service', () => ({
  getAnimeDetail: jest.fn(),
}));

const Subscription = require('../models/Subscription');
const AnimeCache = require('../models/AnimeCache');
const anilistService = require('../services/anilist.service');
const ctrl = require('../controllers/subscription.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const USER_TOKEN = jwt.sign({ userId: 'user123', username: 'alice' }, process.env.JWT_SECRET);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authenticateToken);
  app.get('/api/subscriptions', ctrl.getAll);
  app.get('/api/subscriptions/:anilistId', ctrl.getOne);
  app.post('/api/subscriptions', ctrl.create);
  app.patch('/api/subscriptions/:anilistId', ctrl.update);
  app.delete('/api/subscriptions/:anilistId', ctrl.remove);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

describe('subscription.controller', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  describe('GET /api/subscriptions', () => {
    it('returns user subscriptions with anime data', async () => {
      Subscription.find.mockReturnValue({
        sort: jest.fn().mockResolvedValue([
          { anilistId: 101, status: 'watching', currentEpisode: 3, _id: 'sub1', createdAt: new Date() },
        ]),
      });
      AnimeCache.find.mockResolvedValue([
        { anilistId: 101, title: { romaji: 'Anime A' }, toObject: () => ({ anilistId: 101, title: { romaji: 'Anime A' } }) },
      ]);

      const res = await request(app)
        .get('/api/subscriptions')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('watching');
      expect(res.body.data[0].anilistId).toBe(101);
    });

    it('filters by status query param', async () => {
      Subscription.find.mockReturnValue({
        sort: jest.fn().mockResolvedValue([]),
      });
      AnimeCache.find.mockResolvedValue([]);

      await request(app)
        .get('/api/subscriptions?status=completed')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(Subscription.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
    });
  });

  describe('GET /api/subscriptions/:anilistId', () => {
    it('returns a single subscription', async () => {
      Subscription.findOne.mockResolvedValue({
        anilistId: 101, status: 'watching', currentEpisode: 5,
      });

      const res = await request(app)
        .get('/api/subscriptions/101')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.data.anilistId).toBe(101);
    });

    it('returns 404 when subscription not found', async () => {
      Subscription.findOne.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/subscriptions/999')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/subscriptions', () => {
    it('creates or upserts a subscription', async () => {
      anilistService.getAnimeDetail.mockResolvedValue({ anilistId: 101 });
      Subscription.findOneAndUpdate.mockResolvedValue({
        anilistId: 101, status: 'watching', userId: 'user123',
      });

      const res = await request(app)
        .post('/api/subscriptions')
        .set('Authorization', `Bearer ${USER_TOKEN}`)
        .send({ anilistId: 101, status: 'watching' });

      expect(res.status).toBe(201);
      expect(anilistService.getAnimeDetail).toHaveBeenCalledWith(101);
    });
  });

  describe('PATCH /api/subscriptions/:anilistId', () => {
    it('updates subscription status', async () => {
      Subscription.findOneAndUpdate.mockResolvedValue({
        anilistId: 101, status: 'completed',
      });

      const res = await request(app)
        .patch('/api/subscriptions/101')
        .set('Authorization', `Bearer ${USER_TOKEN}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });

    it('updates currentEpisode and sets lastWatchedAt', async () => {
      Subscription.findOneAndUpdate.mockResolvedValue({
        anilistId: 101, currentEpisode: 5,
      });

      await request(app)
        .patch('/api/subscriptions/101')
        .set('Authorization', `Bearer ${USER_TOKEN}`)
        .send({ currentEpisode: 5 });

      const updateArg = Subscription.findOneAndUpdate.mock.calls[0][1];
      expect(updateArg.currentEpisode).toBe(5);
      expect(updateArg.lastWatchedAt).toBeInstanceOf(Date);
    });

    it('returns 404 when subscription not found', async () => {
      Subscription.findOneAndUpdate.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/subscriptions/999')
        .set('Authorization', `Bearer ${USER_TOKEN}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/subscriptions/:anilistId', () => {
    it('deletes subscription', async () => {
      Subscription.findOneAndDelete.mockResolvedValue({ anilistId: 101 });

      const res = await request(app)
        .delete('/api/subscriptions/101')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('已删除');
    });

    it('returns 404 when subscription not found', async () => {
      Subscription.findOneAndDelete.mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/subscriptions/999')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(res.status).toBe(404);
    });
  });
});
