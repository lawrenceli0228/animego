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

    it('routes animes.garden JSON results into the response (size in KB → MB)', async () => {
      const gardenJson = {
        status: 'OK',
        complete: false,
        resources: [
          {
            id: 1,
            provider: 'dmhy',
            title: '[桜都字幕組] Test Anime - 01 (1080p)',
            magnet: 'magnet:?xt=urn:btih:abc123',
            size: 702535, // ≈ 686 MB
            createdAt: '2026-05-09T08:00:00.000Z',
            fansub: { id: 1, name: '桜都字幕組' },
          },
          {
            id: 2,
            provider: 'moe',
            title: 'Bare title with no fansub object',
            magnet: 'magnet:?xt=urn:btih:def456',
            size: 3460300, // ≈ 3.5 GB
            createdAt: '2026-05-08T08:00:00.000Z',
            // no fansub object — falls back to bracket parsing (none here → null)
          },
          {
            // dropped: no magnet
            id: 3,
            provider: 'dmhy',
            title: 'Broken row',
            magnet: '',
            size: 1000,
            createdAt: '2026-05-07T08:00:00.000Z',
          },
        ],
      }
      global.fetch = jest.fn((url) => {
        if (String(url).startsWith('https://api.animes.garden/')) {
          return Promise.resolve({ ok: true, json: async () => gardenJson, text: async () => '' })
        }
        return Promise.resolve({ ok: true, text: async () => '<rss><channel></channel></rss>' })
      })

      const res = await request(app).get('/api/anime/torrents?q=garden+probe')
      expect(res.status).toBe(200)
      const garden = res.body.data.filter((d) => d.source === 'garden')
      expect(garden).toHaveLength(2)
      expect(garden[0]).toMatchObject({
        title: '[桜都字幕組] Test Anime - 01 (1080p)',
        magnet: 'magnet:?xt=urn:btih:abc123',
        fansub: '桜都字幕組',
        size: '703 MB',
        source: 'garden',
        provider: 'dmhy',
      })
      expect(garden[1]).toMatchObject({
        magnet: 'magnet:?xt=urn:btih:def456',
        size: '3.5 GB',
        provider: 'moe',
      })
      delete global.fetch
    })

    it('survives animes.garden returning malformed JSON (graceful fallback)', async () => {
      global.fetch = jest.fn((url) => {
        if (String(url).startsWith('https://api.animes.garden/')) {
          return Promise.resolve({ ok: true, json: async () => { throw new Error('bad json') }, text: async () => '' })
        }
        return Promise.resolve({ ok: true, text: async () => '<rss><channel></channel></rss>' })
      })
      const res = await request(app).get('/api/anime/torrents?q=garden+broken')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.data)).toBe(true)
      // garden contributed 0 items but the request succeeded
      expect(res.body.data.filter((d) => d.source === 'garden')).toHaveLength(0)
      delete global.fetch
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
      const callsAfterFirst = mockFetch.mock.calls.length
      await request(app).get('/api/anime/torrents?q=test+anime')

      // second request served from cache — no additional fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(callsAfterFirst)

      delete global.fetch
    })

    describe('adaptive TTL', () => {
      // Regression coverage for the 2026-05-27 fix: partial upstream failures
      // (e.g. animes.garden returns empty / throws) used to be cached for a
      // full hour, locking users out of the missing fansub group until TTL
      // expired. The fix shortens the TTL to 5min when garden+nyaa weren't
      // both populated, so the next request retries the empty source.
      //
      // Both `getTorrents` and its private fetchers live in the same module,
      // so we can't dependency-inject — instead drive everything through
      // global.fetch and rely on the cache key being lowercase-trimmed.
      const gardenJsonOk = {
        status: 'OK',
        complete: false,
        resources: [
          {
            id: 1,
            provider: 'dmhy',
            title: '[Test] Foo - 01 (1080p)',
            magnet: 'magnet:?xt=urn:btih:abc',
            size: 1000,
            createdAt: '2026-05-09T08:00:00.000Z',
          },
        ],
      }
      const gardenJsonEmpty = { status: 'OK', complete: false, resources: [] }
      const nyaaRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><item>
  <title>Test - 01</title>
  <link>https://nyaa.si/view/1</link>
  <pubDate>Mon, 01 Jan 2025 00:00:00 +0000</pubDate>
  <enclosure url="https://nyaa.si/view/1.torrent"/>
  <nyaa:infoHash xmlns:nyaa="https://nyaa.si/xmlns/nyaa">deadbeef</nyaa:infoHash>
</item></channel></rss>`
      const acgRipRss = '<?xml version="1.0"?><rss><channel></channel></rss>'

      function buildMockFetch(gardenPayload) {
        return jest.fn(async (url) => {
          const u = String(url)
          if (u.startsWith('https://api.animes.garden/')) {
            return { ok: true, json: async () => gardenPayload, text: async () => '' }
          }
          if (u.includes('nyaa.si')) {
            return { ok: true, text: async () => nyaaRss }
          }
          // acg.rip — keep empty so the success/failure axis is owned by garden+nyaa.
          return { ok: true, text: async () => acgRipRss }
        })
      }

      it('caches a FULL success (garden+nyaa populated) for the long 60min TTL', async () => {
        const fetchMock = buildMockFetch(gardenJsonOk)
        global.fetch = fetchMock

        // First fetch primes the cache.
        let res = await request(app).get('/api/anime/torrents?q=ttl+full')
        expect(res.status).toBe(200)
        expect(res.body.data.filter((d) => d.source === 'garden').length).toBeGreaterThan(0)
        expect(res.body.data.filter((d) => d.source === 'nyaa').length).toBeGreaterThan(0)
        const baselineCalls = fetchMock.mock.calls.length

        // 30 minutes later — still inside the 60min full-success TTL.
        const realNow = Date.now
        Date.now = () => realNow() + 30 * 60 * 1000
        try {
          res = await request(app).get('/api/anime/torrents?q=ttl+full')
          expect(res.status).toBe(200)
          expect(fetchMock).toHaveBeenCalledTimes(baselineCalls)
        } finally {
          Date.now = realNow
          delete global.fetch
        }
      })

      it('expires a PARTIAL response (garden empty) after 5min so a retry fires', async () => {
        // Round 1: garden returns empty -> partial cache, 5min TTL.
        const partialFetch = buildMockFetch(gardenJsonEmpty)
        global.fetch = partialFetch

        let res = await request(app).get('/api/anime/torrents?q=ttl+partial')
        expect(res.status).toBe(200)
        expect(res.body.data.filter((d) => d.source === 'garden')).toHaveLength(0)
        const baselineCalls = partialFetch.mock.calls.length

        // 6 minutes later — past the partial-TTL but well before the long one.
        // Swap in a healthy fetch so we can observe the recovery.
        const realNow = Date.now
        Date.now = () => realNow() + 6 * 60 * 1000
        const healthyFetch = buildMockFetch(gardenJsonOk)
        global.fetch = healthyFetch
        try {
          res = await request(app).get('/api/anime/torrents?q=ttl+partial')
          expect(res.status).toBe(200)
          // Garden recovers because the partial cache entry was evicted.
          expect(res.body.data.filter((d) => d.source === 'garden').length).toBeGreaterThan(0)
          expect(healthyFetch.mock.calls.length).toBeGreaterThan(0)
          // And the original mock saw no further calls in the recovery round.
          expect(partialFetch).toHaveBeenCalledTimes(baselineCalls)
        } finally {
          Date.now = realNow
          delete global.fetch
        }
      })

      it('serves a partial entry from cache when re-queried inside 5min', async () => {
        const partialFetch = buildMockFetch(gardenJsonEmpty)
        global.fetch = partialFetch

        await request(app).get('/api/anime/torrents?q=ttl+partial+warm')
        const baselineCalls = partialFetch.mock.calls.length

        // 2 minutes later — still inside the 5min partial TTL.
        const realNow = Date.now
        Date.now = () => realNow() + 2 * 60 * 1000
        try {
          const res = await request(app).get('/api/anime/torrents?q=ttl+partial+warm')
          expect(res.status).toBe(200)
          // Served from cache: no new fetch calls.
          expect(partialFetch).toHaveBeenCalledTimes(baselineCalls)
        } finally {
          Date.now = realNow
          delete global.fetch
        }
      })
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
