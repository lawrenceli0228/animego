const request = require('supertest')
const express = require('express')

// Mock anilist service
jest.mock('../services/anilist.service', () => ({
  getSeasonalAnime: jest.fn(),
  searchAnime: jest.fn(),
  getWeeklySchedule: jest.fn(),
}))

// Mock Subscription model
jest.mock('../models/Subscription', () => ({
  aggregate: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
}))

// Mock AnimeCache model
jest.mock('../models/AnimeCache', () => ({
  find: jest.fn(),
}))

const anilistService = require('../services/anilist.service')
const Subscription = require('../models/Subscription')
const AnimeCache = require('../models/AnimeCache')
const animeController = require('../controllers/anime.controller')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.get('/api/anime/trending', animeController.getTrending)
  app.get('/api/anime/:anilistId/watchers', animeController.getWatchers)
  app.get('/api/anime/seasonal', animeController.getSeasonal)
  app.get('/api/anime/search', animeController.search)
  app.get('/api/anime/torrents', animeController.getTorrents)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('anime.controller', () => {
  let app

  beforeEach(() => {
    app = buildApp()
    jest.clearAllMocks()
  })

  describe('GET /api/anime/search', () => {
    it('returns 400 when no query or genre provided', async () => {
      const res = await request(app).get('/api/anime/search')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns results when query is provided', async () => {
      anilistService.searchAnime.mockResolvedValue({
        anime: [{ id: 1, title: 'Naruto' }],
        pageInfo: { currentPage: 1, perPage: 20, total: 1, lastPage: 1 },
      })
      const res = await request(app).get('/api/anime/search?q=naruto')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
    })

    it('clamps perPage to 50 max', async () => {
      anilistService.searchAnime.mockResolvedValue({
        anime: [],
        pageInfo: { currentPage: 1, perPage: 50, total: 0, lastPage: 1 },
      })
      await request(app).get('/api/anime/search?q=test&perPage=999')
      expect(anilistService.searchAnime).toHaveBeenCalledWith(
        'test', undefined, expect.anything(), 50
      )
    })
  })

  describe('GET /api/anime/torrents', () => {
    it('returns 400 when q is missing', async () => {
      const res = await request(app).get('/api/anime/torrents')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('uses in-memory cache on second identical request', async () => {
      const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>Test Anime S01E01</title>
    <link>https://acg.rip/t/1</link>
    <pubDate>Mon, 01 Jan 2025 00:00:00 +0000</pubDate>
    <enclosure url="https://acg.rip/t/1.torrent" type="application/x-bittorrent" length="0"/>
  </item>
</channel></rss>`

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => rssXml,
      })
      global.fetch = mockFetch

      await request(app).get('/api/anime/torrents?q=test+anime')
      await request(app).get('/api/anime/torrents?q=test+anime')

      // fetch should only be called once — second request served from cache
      expect(mockFetch).toHaveBeenCalledTimes(1)

      delete global.fetch
    })
  })

  describe('GET /api/anime/seasonal', () => {
    it('returns paginated seasonal anime', async () => {
      anilistService.getSeasonalAnime.mockResolvedValue({
        anime: [{ id: 42 }],
        pageInfo: { currentPage: 1, perPage: 20, total: 1, lastPage: 1 },
      })
      const res = await request(app).get('/api/anime/seasonal')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.pagination).toBeDefined()
    })
  })

  describe('GET /api/anime/trending', () => {
    beforeEach(() => {
      // Reset module-level cache between tests by clearing mock state
      Subscription.aggregate.mockReset()
      AnimeCache.find.mockReset()
    })

    it('returns ranked trending anime from aggregate', async () => {
      Subscription.aggregate.mockResolvedValue([
        { _id: 101, count: 5 },
        { _id: 202, count: 3 },
      ])
      AnimeCache.find.mockResolvedValue([
        { anilistId: 101, title: { romaji: 'Anime A' }, toObject: () => ({ anilistId: 101, title: { romaji: 'Anime A' } }) },
        { anilistId: 202, title: { romaji: 'Anime B' }, toObject: () => ({ anilistId: 202, title: { romaji: 'Anime B' } }) },
      ])

      // Force cache miss by using refresh=true
      const res = await request(app).get('/api/anime/trending?refresh=true&limit=10')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data[0].rank).toBe(1)
      expect(res.body.data[0].watcherCount).toBe(5)
      expect(res.body.data[1].rank).toBe(2)
    })

    it('clamps limit to max 20', async () => {
      Subscription.aggregate.mockResolvedValue([])
      AnimeCache.find.mockResolvedValue([])

      const res = await request(app).get('/api/anime/trending?refresh=true&limit=999')
      expect(res.status).toBe(200)
      // aggregate is called with $limit: 20
      expect(Subscription.aggregate).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ $limit: 20 })])
      )
    })

    it('filters out animes not in AnimeCache', async () => {
      Subscription.aggregate.mockResolvedValue([
        { _id: 101, count: 5 },
        { _id: 999, count: 3 }, // no matching cache entry
      ])
      AnimeCache.find.mockResolvedValue([
        { anilistId: 101, toObject: () => ({ anilistId: 101 }) },
      ])

      const res = await request(app).get('/api/anime/trending?refresh=true')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].anilistId).toBe(101)
    })
  })

  describe('GET /api/anime/:anilistId/watchers', () => {
    it('returns watchers list and total', async () => {
      Subscription.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          { userId: { username: 'alice' } },
          { userId: { username: 'bob' } },
        ]),
      })
      Subscription.countDocuments.mockResolvedValue(10)

      const res = await request(app).get('/api/anime/101/watchers')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data[0].username).toBe('alice')
      expect(res.body.total).toBe(10)
    })

    it('returns 400 for non-numeric anilistId', async () => {
      const res = await request(app).get('/api/anime/abc/watchers')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('filters out watchers with null userId (deleted users)', async () => {
      Subscription.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          { userId: { username: 'alice' } },
          { userId: null }, // deleted user
        ]),
      })
      Subscription.countDocuments.mockResolvedValue(2)

      const res = await request(app).get('/api/anime/101/watchers')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].username).toBe('alice')
    })
  })
})
