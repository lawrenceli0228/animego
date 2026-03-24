const request = require('supertest')
const express = require('express')

// Mock anilist service
jest.mock('../services/anilist.service', () => ({
  getSeasonalAnime: jest.fn(),
  searchAnime: jest.fn(),
  getWeeklySchedule: jest.fn(),
}))

const anilistService = require('../services/anilist.service')
const animeController = require('../controllers/anime.controller')

function buildApp() {
  const app = express()
  app.use(express.json())
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
})
