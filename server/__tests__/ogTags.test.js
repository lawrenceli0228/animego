const express = require('express')
const request = require('supertest')

jest.mock('../models/AnimeCache', () => ({
  findOne: jest.fn(),
}))

const AnimeCache = require('../models/AnimeCache')
const ogTagsMiddleware = require('../middleware/ogTags')

function buildApp() {
  const app = express()
  app.use(ogTagsMiddleware)
  app.get('*', (req, res) => res.send('SPA'))
  return app
}

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const TWITTERBOT_UA = 'Twitterbot/1.0'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

describe('ogTags middleware', () => {
  let app

  beforeEach(() => {
    app = buildApp()
    jest.clearAllMocks()
    // Default: homepage queries popular anime
    AnimeCache.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { anilistId: 1, titleChinese: '测试动画', averageScore: 90, genres: ['Action'] },
          ]),
        }),
      }),
    })
  })

  describe('crawler detection', () => {
    it('passes through for normal browsers', async () => {
      const res = await request(app).get('/').set('User-Agent', BROWSER_UA)
      expect(res.text).toBe('SPA')
    })

    it('intercepts Googlebot', async () => {
      const res = await request(app).get('/').set('User-Agent', GOOGLEBOT_UA)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.text).toContain('og:title')
    })

    it('intercepts Twitterbot', async () => {
      const res = await request(app).get('/').set('User-Agent', TWITTERBOT_UA)
      expect(res.text).toContain('twitter:card')
    })

    it('intercepts Discordbot', async () => {
      const res = await request(app).get('/').set('User-Agent', 'Discordbot/2.0')
      expect(res.text).toContain('og:title')
    })
  })

  describe('homepage route', () => {
    it('returns OG tags for homepage', async () => {
      const res = await request(app).get('/').set('User-Agent', GOOGLEBOT_UA)
      expect(res.status).toBe(200)
      expect(res.text).toContain('AnimeGo')
      expect(res.text).toContain('og:description')
    })
  })

  describe('/anime/:id route', () => {
    it('returns OG tags with anime data from cache', async () => {
      AnimeCache.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          titleChinese: '进击的巨人',
          titleNative: '進撃の巨人',
          description: '<p>A great anime</p>',
          coverImageUrl: 'https://img.com/cover.jpg',
          bannerImageUrl: 'https://img.com/banner.jpg',
          genres: ['Action', 'Drama', 'Fantasy'],
        }),
      })

      const res = await request(app).get('/anime/16498').set('User-Agent', GOOGLEBOT_UA)
      expect(res.status).toBe(200)
      expect(res.text).toContain('进击的巨人')
      expect(res.text).toContain('A great anime') // HTML stripped from description
      // The og:description content should not contain HTML tags from the source
      expect(res.text).toMatch(/og:description" content="A great anime"/)
      expect(res.text).toContain('banner.jpg')
      expect(res.text).toContain('Action, Drama, Fantasy')
    })

    it('returns fallback OG HTML with correct canonical when anime not in cache', async () => {
      AnimeCache.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      })

      const res = await request(app).get('/anime/99999').set('User-Agent', GOOGLEBOT_UA)
      expect(res.status).toBe(200)
      expect(res.text).toContain('<title>动画 #99999 - AnimeGoClub</title>')
      expect(res.text).toContain('<link rel="canonical" href="https://animegoclub.com/anime/99999">')
      expect(res.text).toContain('og:url')
    })

    it('returns fallback HTML on cache error', async () => {
      AnimeCache.findOne.mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error('DB error')),
      })

      const res = await request(app).get('/anime/12345').set('User-Agent', GOOGLEBOT_UA)
      expect(res.status).toBe(200)
      expect(res.text).toContain('动画 #12345')
      expect(res.text).toContain('AnimeGo')
    })

    it('uses fallback title when titleChinese is absent', async () => {
      AnimeCache.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          titleChinese: null,
          titleNative: null,
          titleRomaji: 'Shingeki no Kyojin',
          titleEnglish: 'Attack on Titan',
          description: 'desc',
          coverImageUrl: 'cover.jpg',
        }),
      })

      const res = await request(app).get('/anime/16498').set('User-Agent', GOOGLEBOT_UA)
      expect(res.text).toContain('Shingeki no Kyojin')
    })
  })

  describe('/season route', () => {
    it('returns OG tags for season page', async () => {
      const res = await request(app).get('/season').set('User-Agent', GOOGLEBOT_UA)
      expect(res.status).toBe(200)
      expect(res.text).toContain('季度新番')
    })
  })

  describe('/search route', () => {
    it('returns OG tags for search page', async () => {
      const res = await request(app).get('/search').set('User-Agent', GOOGLEBOT_UA)
      expect(res.status).toBe(200)
      expect(res.text).toContain('搜索动画')
    })
  })

  describe('unknown routes', () => {
    it('falls through for unhandled paths', async () => {
      const res = await request(app).get('/about').set('User-Agent', GOOGLEBOT_UA)
      expect(res.text).toBe('SPA')
    })
  })

  describe('XSS prevention', () => {
    it('escapes HTML entities in title and description', async () => {
      AnimeCache.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          titleChinese: '<script>alert("xss")</script>',
          description: '"><img src=x onerror=alert(1)>',
          coverImageUrl: 'cover.jpg',
        }),
      })

      const res = await request(app).get('/anime/1').set('User-Agent', GOOGLEBOT_UA)
      // Should not contain unescaped XSS payload (legitimate ld+json script tags are OK)
      expect(res.text).not.toContain('<script>alert')
      expect(res.text).toContain('&lt;script&gt;')
    })
  })
})
