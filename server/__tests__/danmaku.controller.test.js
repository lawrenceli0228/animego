const request = require('supertest')
const express = require('express')

jest.mock('../models/Danmaku')
jest.mock('../models/EpisodeWindow')

const Danmaku       = require('../models/Danmaku')
const EpisodeWindow = require('../models/EpisodeWindow')
const ctrl          = require('../controllers/danmaku.controller')

function buildApp() {
  const app = express()
  app.get('/api/danmaku/:anilistId/:episode', ctrl.getDanmaku)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('danmaku.controller', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('GET /api/danmaku/:anilistId/:episode', () => {
    it('returns 400 for non-numeric anilistId', async () => {
      const res = await request(buildApp()).get('/api/danmaku/abc/1')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for non-numeric episode', async () => {
      const res = await request(buildApp()).get('/api/danmaku/101/xyz')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns empty array and null liveEndsAt when no danmaku', async () => {
      const danmakuQuery = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        then: jest.fn((cb) => Promise.resolve(cb([]))),
      }
      Danmaku.find = jest.fn().mockReturnValue(danmakuQuery)
      EpisodeWindow.findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) })

      const res = await request(buildApp()).get('/api/danmaku/101/1')
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
      expect(res.body.liveEndsAt).toBeNull()
    })

    it('returns danmaku list with liveEndsAt when window exists', async () => {
      const liveEndsAt = new Date(Date.now() + 60000).toISOString()
      const mockDocs = [{ username: 'alice', content: 'hello', createdAt: new Date() }]
      const danmakuQuery = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        then: jest.fn((cb) => Promise.resolve(cb(mockDocs))),
      }
      Danmaku.find = jest.fn().mockReturnValue(danmakuQuery)
      EpisodeWindow.findOne = jest.fn().mockReturnValue({
        lean: () => Promise.resolve({ liveEndsAt })
      })

      const res = await request(buildApp()).get('/api/danmaku/101/1')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].username).toBe('alice')
      expect(res.body.liveEndsAt).toBe(liveEndsAt)
    })
  })
})
