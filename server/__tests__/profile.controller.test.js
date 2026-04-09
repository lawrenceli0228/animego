const request = require('supertest')
const express = require('express')
const mongoose = require('mongoose')

jest.mock('../models/User')
jest.mock('../models/Subscription')
jest.mock('../models/AnimeCache')
jest.mock('../models/Follow')

const User         = require('../models/User')
const Subscription = require('../models/Subscription')
const AnimeCache   = require('../models/AnimeCache')
const Follow       = require('../models/Follow')
const ctrl         = require('../controllers/profile.controller')

const USER_A = new mongoose.Types.ObjectId()
const USER_B = new mongoose.Types.ObjectId()

function buildApp(userId = null) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.user = userId ? { userId } : undefined
    next()
  })
  app.get('/api/users/:username', ctrl.getProfile)
  app.get('/api/feed', ctrl.getFeed)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('profile.controller', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('GET /api/users/:username', () => {
    it('returns 404 when user not found', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) })
      const res = await request(buildApp()).get('/api/users/nobody')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })

    it('returns profile with isFollowing=null for unauthenticated visitor', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve({ _id: USER_B, username: 'bob', createdAt: new Date() }) })
      const subsQuery = { sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }
      Subscription.find = jest.fn().mockReturnValue(subsQuery)
      Follow.countDocuments = jest.fn().mockResolvedValue(0)
      Follow.exists = jest.fn()
      AnimeCache.find = jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) })

      const res = await request(buildApp(null)).get('/api/users/bob')
      expect(res.status).toBe(200)
      expect(res.body.data.isFollowing).toBeNull()
      expect(Follow.exists).not.toHaveBeenCalled()
    })

    it('returns isFollowing=true for authenticated follower', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve({ _id: USER_B, username: 'bob', createdAt: new Date() }) })
      const subsQuery = { sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }
      Subscription.find = jest.fn().mockReturnValue(subsQuery)
      Follow.countDocuments = jest.fn().mockResolvedValue(0)
      Follow.exists = jest.fn().mockResolvedValue({ _id: 'follow-id' }) // truthy = following
      AnimeCache.find = jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) })

      const res = await request(buildApp(USER_A.toString())).get('/api/users/bob')
      expect(res.status).toBe(200)
      expect(res.body.data.isFollowing).toBe(true)
    })

    it('returns follower/following counts', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve({ _id: USER_B, username: 'bob', createdAt: new Date() }) })
      const subsQuery = { sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }
      Subscription.find = jest.fn().mockReturnValue(subsQuery)
      Follow.countDocuments = jest.fn()
        .mockResolvedValueOnce(5)  // followerCount
        .mockResolvedValueOnce(3)  // followingCount
      Follow.exists = jest.fn().mockResolvedValue(null)
      AnimeCache.find = jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) })

      const res = await request(buildApp(USER_A.toString())).get('/api/users/bob')
      expect(res.body.data.followerCount).toBe(5)
      expect(res.body.data.followingCount).toBe(3)
    })
  })

  describe('GET /api/feed', () => {
    it('returns 401 when user is not authenticated', async () => {
      const res = await request(buildApp(null)).get('/api/feed')
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })

    it('returns empty array when user follows nobody', async () => {
      Follow.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      })
      const res = await request(buildApp(USER_A.toString())).get('/api/feed')
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
      expect(res.body.hasMore).toBe(false)
      expect(res.body.nextPage).toBeNull()
    })

    it('returns paginated activity feed for followed users', async () => {
      Follow.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ followeeId: USER_B }]),
      })
      const subsQuery = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{
          userId: { username: 'bob' },
          anilistId: 101,
          status: 'watching',
          currentEpisode: 3,
          lastWatchedAt: new Date(),
        }]),
      }
      Subscription.find = jest.fn().mockReturnValue(subsQuery)
      Subscription.countDocuments = jest.fn().mockResolvedValue(1)
      AnimeCache.find = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { anilistId: 101, titleRomaji: 'Test Anime', titleChinese: '测试动漫', coverImageUrl: 'img.jpg' }
        ])
      })

      const res = await request(buildApp(USER_A.toString())).get('/api/feed')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].username).toBe('bob')
      expect(res.body.data[0].anilistId).toBe(101)
      expect(res.body.hasMore).toBe(false)
      expect(res.body.nextPage).toBeNull()
    })

    it('returns hasMore=true and nextPage when more items exist', async () => {
      Follow.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ followeeId: USER_B }]),
      })
      const subsQuery = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{
          userId: { username: 'bob' },
          anilistId: 101,
          status: 'watching',
          currentEpisode: 1,
          lastWatchedAt: new Date(),
        }]),
      }
      Subscription.find = jest.fn().mockReturnValue(subsQuery)
      Subscription.countDocuments = jest.fn().mockResolvedValue(25)
      AnimeCache.find = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { anilistId: 101, titleRomaji: 'Test', coverImageUrl: 'img.jpg' }
        ])
      })

      const res = await request(buildApp(USER_A.toString())).get('/api/feed?page=1')
      expect(res.body.hasMore).toBe(true)
      expect(res.body.nextPage).toBe(2)
    })
  })
})
