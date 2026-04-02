const request = require('supertest')
const express = require('express')
const mongoose = require('mongoose')

jest.mock('../models/Follow')
jest.mock('../models/User')

const Follow = require('../models/Follow')
const User   = require('../models/User')
const ctrl   = require('../controllers/follow.controller')

const USER_A = new mongoose.Types.ObjectId()
const USER_B = new mongoose.Types.ObjectId()

function buildApp(userId = USER_A.toString(), username = 'alice') {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { userId }; next() })
  app.post('/api/users/:username/follow',   ctrl.follow)
  app.delete('/api/users/:username/follow', ctrl.unfollow)
  app.get('/api/users/:username/followers', ctrl.getFollowers)
  app.get('/api/users/:username/following', ctrl.getFollowing)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('follow.controller', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('POST /:username/follow', () => {
    it('returns 404 when followee not found', async () => {
      User.findOne = jest.fn().mockResolvedValue(null)
      const res = await request(buildApp()).post('/api/users/nobody/follow')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })

    it('returns 400 when following self', async () => {
      User.findOne = jest.fn().mockResolvedValue({ _id: USER_A, equals: () => true })
      const res = await request(buildApp(USER_A.toString())).post('/api/users/alice/follow')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('INVALID_ACTION')
    })

    it('returns 201 on successful follow', async () => {
      User.findOne = jest.fn().mockResolvedValue({ _id: USER_B, equals: () => false })
      Follow.findOneAndUpdate = jest.fn().mockResolvedValue({})
      const res = await request(buildApp()).post('/api/users/bob/follow')
      expect(res.status).toBe(201)
      expect(res.body.data.following).toBe(true)
    })

    it('returns 201 idempotently when already following', async () => {
      User.findOne = jest.fn().mockResolvedValue({ _id: USER_B, equals: () => false })
      Follow.findOneAndUpdate = jest.fn().mockResolvedValue({}) // upsert returns existing
      const res = await request(buildApp()).post('/api/users/bob/follow')
      expect(res.status).toBe(201)
    })
  })

  describe('DELETE /:username/follow', () => {
    it('returns 404 when followee not found', async () => {
      User.findOne = jest.fn().mockResolvedValue(null)
      const res = await request(buildApp()).delete('/api/users/nobody/follow')
      expect(res.status).toBe(404)
    })

    it('returns 200 on unfollow (idempotent)', async () => {
      User.findOne = jest.fn().mockResolvedValue({ _id: USER_B })
      Follow.findOneAndDelete = jest.fn().mockResolvedValue(null) // null = was not following
      const res = await request(buildApp()).delete('/api/users/bob/follow')
      expect(res.status).toBe(200)
      expect(res.body.data.following).toBe(false)
    })
  })

  describe('GET /:username/followers', () => {
    it('returns 404 when user not found', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) })
      const res = await request(buildApp()).get('/api/users/nobody/followers')
      expect(res.status).toBe(404)
    })

    it('returns paginated follower list', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve({ _id: USER_B }) })
      const mockQuery = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ followerId: { username: 'alice' } }]),
      }
      Follow.find = jest.fn().mockReturnValue(mockQuery)
      Follow.countDocuments = jest.fn().mockResolvedValue(1)

      const res = await request(buildApp()).get('/api/users/bob/followers?page=1')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].username).toBe('alice')
      expect(res.body.total).toBe(1)
    })
  })

  describe('GET /:username/following', () => {
    it('returns 404 when user not found', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) })
      const res = await request(buildApp()).get('/api/users/nobody/following')
      expect(res.status).toBe(404)
    })

    it('returns following list', async () => {
      User.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve({ _id: USER_A }) })
      const mockQuery = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ followeeId: { username: 'bob' } }]),
      }
      Follow.find = jest.fn().mockReturnValue(mockQuery)
      Follow.countDocuments = jest.fn().mockResolvedValue(1)

      const res = await request(buildApp()).get('/api/users/alice/following')
      expect(res.status).toBe(200)
      expect(res.body.data[0].username).toBe('bob')
    })
  })
})
