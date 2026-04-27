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
    expect(res.text).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"')
    expect(res.text).toContain('<loc>')
    expect(res.text).toContain('/season</loc>')
    expect(res.text).toContain('/search</loc>')
    expect(res.text).toContain('/calendar</loc>')
    expect(res.text).toContain('/about</loc>')
    expect(res.text).toContain('/faq</loc>')
    expect(res.text).toContain('</urlset>')
  })

  it('includes seasonal URLs covering current year ±1', async () => {
    const AnimeCache = require('../models/AnimeCache')
    AnimeCache.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    })

    const app = buildApp()
    const res = await request(app).get('/sitemap.xml')

    const currentYear = new Date().getFullYear()
    expect(res.text).toContain(`/season?year=${currentYear}&amp;season=SPRING</loc>`)
    expect(res.text).toContain(`/season?year=${currentYear - 1}&amp;season=WINTER</loc>`)
    expect(res.text).toContain(`/season?year=${currentYear + 1}&amp;season=FALL</loc>`)
  })

  it('includes anime entries with image:image blocks', async () => {
    const AnimeCache = require('../models/AnimeCache')
    AnimeCache.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          anilistId: 101,
          cachedAt: new Date('2025-01-15'),
          coverImageUrl: 'https://img.com/cover101.jpg',
          titleChinese: '进击的巨人',
        },
        {
          anilistId: 202,
          cachedAt: new Date('2025-02-20'),
          coverImageUrl: 'https://img.com/cover202.jpg',
          titleRomaji: 'Naruto',
        },
      ]),
    })

    const app = buildApp()
    const res = await request(app).get('/sitemap.xml')

    expect(res.text).toContain('/anime/101</loc>')
    expect(res.text).toContain('/anime/202</loc>')
    expect(res.text).toContain('2025-01-15')
    expect(res.text).toContain('2025-02-20')
    expect(res.text).toContain('<image:image>')
    expect(res.text).toContain('<image:loc>https://img.com/cover101.jpg</image:loc>')
    expect(res.text).toContain('<image:title>进击的巨人</image:title>')
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
