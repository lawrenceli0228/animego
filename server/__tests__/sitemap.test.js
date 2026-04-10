const request = require('supertest')
const express = require('express')

jest.mock('../models/AnimeCache', () => ({
  find: jest.fn(),
}))

const AnimeCache = require('../models/AnimeCache')

// Re-require for each test to reset module-level cache
let sitemapMiddleware

function buildApp() {
  const app = express()
  app.get('/sitemap.xml', sitemapMiddleware)
  return app
}

describe('sitemap middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.resetModules()
    jest.mock('../models/AnimeCache', () => ({
      find: jest.fn(),
    }))
    sitemapMiddleware = require('../middleware/sitemap')
  })

  it('returns valid XML with static routes', async () => {
    const AnimeCache = require('../models/AnimeCache')
    AnimeCache.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    })

    const app = buildApp()
    const res = await request(app).get('/sitemap.xml')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/xml')
    expect(res.text).toContain('<urlset')
    expect(res.text).toContain('<loc>')
    expect(res.text).toContain('/season</loc>')
    expect(res.text).toContain('/search</loc>')
    expect(res.text).toContain('</urlset>')
  })

  it('includes anime entries from AnimeCache', async () => {
    const AnimeCache = require('../models/AnimeCache')
    AnimeCache.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { anilistId: 101, cachedAt: new Date('2025-01-15') },
        { anilistId: 202, cachedAt: new Date('2025-02-20') },
      ]),
    })

    const app = buildApp()
    const res = await request(app).get('/sitemap.xml')

    expect(res.text).toContain('/anime/101</loc>')
    expect(res.text).toContain('/anime/202</loc>')
    expect(res.text).toContain('2025-01-15')
    expect(res.text).toContain('2025-02-20')
  })

  it('serves cached XML on subsequent requests within TTL', async () => {
    const AnimeCache = require('../models/AnimeCache')
    AnimeCache.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ anilistId: 1, cachedAt: new Date() }]),
    })

    const app = buildApp()
    await request(app).get('/sitemap.xml')
    const callCount = AnimeCache.find.mock.calls.length

    // Second request should hit cache
    await request(app).get('/sitemap.xml')
    expect(AnimeCache.find).toHaveBeenCalledTimes(callCount)
  })

  it('uses today as lastmod when cachedAt is missing', async () => {
    const AnimeCache = require('../models/AnimeCache')
    AnimeCache.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { anilistId: 303, cachedAt: null },
      ]),
    })

    const app = buildApp()
    const res = await request(app).get('/sitemap.xml')
    const today = new Date().toISOString().split('T')[0]
    expect(res.text).toContain('/anime/303</loc>')
    expect(res.text).toContain(today)
  })
})
