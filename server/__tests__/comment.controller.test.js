const request = require('supertest')
const express = require('express')
const mongoose = require('mongoose')

jest.mock('../models/EpisodeComment')
const EpisodeComment = require('../models/EpisodeComment')
const ctrl = require('../controllers/comment.controller')

const USER_A = new mongoose.Types.ObjectId().toString()
const USER_B = new mongoose.Types.ObjectId().toString()

function buildApp(userId = USER_A, username = 'alice') {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.user = { userId, username }
    next()
  })
  app.post('/api/comments/:anilistId/:episode', ctrl.addComment)
  app.delete('/api/comments/:id', ctrl.deleteComment)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('comment.controller', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('POST /api/comments/:anilistId/:episode — content validation', () => {
    it('returns 400 when content is empty', async () => {
      const app = buildApp()
      const res = await request(app)
        .post('/api/comments/1/1')
        .send({ content: '' })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 when content exceeds 500 characters', async () => {
      const app = buildApp()
      const res = await request(app)
        .post('/api/comments/1/1')
        .send({ content: 'a'.repeat(501) })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 201 when content is exactly 500 characters', async () => {
      EpisodeComment.create = jest.fn().mockResolvedValue({
        anilistId: 1, episode: 1, content: 'a'.repeat(500),
        userId: USER_A, username: 'alice',
      })
      const app = buildApp()
      const res = await request(app)
        .post('/api/comments/1/1')
        .send({ content: 'a'.repeat(500) })
      expect(res.status).toBe(201)
    })

    it('returns 201 for valid content', async () => {
      EpisodeComment.create = jest.fn().mockResolvedValue({
        anilistId: 1, episode: 1, content: 'Great episode!',
        userId: USER_A, username: 'alice',
      })
      const app = buildApp()
      const res = await request(app)
        .post('/api/comments/1/1')
        .send({ content: 'Great episode!' })
      expect(res.status).toBe(201)
      expect(res.body.data.content).toBe('Great episode!')
    })
  })

  describe('DELETE /api/comments/:id — ownership check', () => {
    it('returns 403 when user tries to delete another user\'s comment', async () => {
      EpisodeComment.findById = jest.fn().mockResolvedValue({
        _id: 'comment-1',
        userId: new mongoose.Types.ObjectId(USER_B),
        deleteOne: jest.fn(),
      })
      const app = buildApp(USER_A)
      const res = await request(app).delete('/api/comments/comment-1')
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('returns 200 when user deletes their own comment', async () => {
      const deleteOne = jest.fn().mockResolvedValue({})
      EpisodeComment.findById = jest.fn().mockResolvedValue({
        _id: 'comment-1',
        userId: new mongoose.Types.ObjectId(USER_A),
        deleteOne,
      })
      const app = buildApp(USER_A)
      const res = await request(app).delete('/api/comments/comment-1')
      expect(res.status).toBe(200)
      expect(deleteOne).toHaveBeenCalledTimes(1)
    })

    it('returns 404 when comment does not exist', async () => {
      EpisodeComment.findById = jest.fn().mockResolvedValue(null)
      const app = buildApp(USER_A)
      const res = await request(app).delete('/api/comments/nonexistent')
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })
  })
})
