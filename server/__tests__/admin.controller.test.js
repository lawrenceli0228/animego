const request = require('supertest')
const express = require('express')

jest.mock('../models/AnimeCache')
jest.mock('../models/User')
jest.mock('../models/Subscription')
jest.mock('../models/Follow')
jest.mock('../services/bangumi.service')

const AnimeCache = require('../models/AnimeCache')
const User = require('../models/User')
const Subscription = require('../models/Subscription')
const Follow = require('../models/Follow')
const { enqueueEnrichment } = require('../services/bangumi.service')
const adminAuth = require('../middleware/adminAuth')
const ctrl = require('../controllers/admin.controller')

function buildApp(role = 'admin') {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.user = { userId: 'user1', username: 'testadmin', role }
    next()
  })
  app.get('/api/admin/stats', adminAuth, ctrl.getStats)
  app.get('/api/admin/enrichment', adminAuth, ctrl.listEnrichment)
  app.post('/api/admin/enrichment/:anilistId/reset', adminAuth, ctrl.resetEnrichment)
  app.post('/api/admin/enrichment/:anilistId/flag', adminAuth, ctrl.flagEnrichment)
  app.get('/api/admin/users', adminAuth, ctrl.listUsers)
  app.post('/api/admin/users', adminAuth, ctrl.createUser)
  app.patch('/api/admin/users/:userId', adminAuth, ctrl.updateUser)
  app.delete('/api/admin/users/:userId', adminAuth, ctrl.deleteUser)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('adminAuth middleware', () => {
  it('returns 403 for non-admin user', async () => {
    const res = await request(buildApp(null)).get('/api/admin/stats')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('allows admin user through', async () => {
    User.countDocuments = jest.fn().mockResolvedValue(1)
    AnimeCache.countDocuments = jest.fn().mockResolvedValue(0)
    Subscription.countDocuments = jest.fn().mockResolvedValue(0)
    Follow.countDocuments = jest.fn().mockResolvedValue(0)

    const res = await request(buildApp('admin')).get('/api/admin/stats')
    expect(res.status).toBe(200)
  })
})

describe('GET /api/admin/stats', () => {
  const app = buildApp()
  beforeEach(() => jest.clearAllMocks())

  it('returns dashboard stats', async () => {
    User.countDocuments = jest.fn().mockResolvedValue(5)
    AnimeCache.countDocuments = jest.fn()
      .mockResolvedValueOnce(100) // total anime
      .mockResolvedValueOnce(10)  // v0
      .mockResolvedValueOnce(20)  // v1
      .mockResolvedValueOnce(70)  // v2
      .mockResolvedValueOnce(3)   // flagged
    Subscription.countDocuments = jest.fn().mockResolvedValue(50)
    Follow.countDocuments = jest.fn().mockResolvedValue(12)

    const res = await request(app).get('/api/admin/stats')
    expect(res.status).toBe(200)
    expect(res.body.data.users).toBe(5)
    expect(res.body.data.anime).toBe(100)
    expect(res.body.data.enrichment).toEqual({ v0: 10, v1: 20, v2: 70 })
    expect(res.body.data.flagged).toBe(3)
    expect(res.body.data.subscriptions).toBe(50)
    expect(res.body.data.follows).toBe(12)
  })
})

describe('GET /api/admin/enrichment', () => {
  const app = buildApp()

  beforeEach(() => jest.clearAllMocks())

  function mockFind(items = []) {
    AnimeCache.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(items),
    })
    AnimeCache.countDocuments = jest.fn().mockResolvedValue(items.length)
  }

  it('returns paginated enrichment list', async () => {
    mockFind([{ anilistId: 1, titleRomaji: 'Test', bangumiVersion: 2, adminFlag: null }])

    const res = await request(app).get('/api/admin/enrichment?page=1')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.total).toBe(1)
    expect(res.body.hasMore).toBe(false)
  })

  it('filters by needs-review', async () => {
    mockFind()
    await request(app).get('/api/admin/enrichment?filter=needs-review')
    expect(AnimeCache.find).toHaveBeenCalledWith({ adminFlag: 'needs-review' })
  })

  it('filters by unenriched', async () => {
    mockFind()
    await request(app).get('/api/admin/enrichment?filter=unenriched')
    expect(AnimeCache.find).toHaveBeenCalledWith({ bangumiVersion: 0 })
  })

  it('searches by anilistId when query is numeric', async () => {
    mockFind()
    await request(app).get('/api/admin/enrichment?q=12345')
    expect(AnimeCache.find).toHaveBeenCalledWith({ anilistId: 12345 })
  })

  it('searches by title when query is text', async () => {
    mockFind()
    await request(app).get('/api/admin/enrichment?q=naruto')
    const calledFilter = AnimeCache.find.mock.calls[0][0]
    expect(calledFilter.$or).toBeDefined()
    expect(calledFilter.$or).toHaveLength(3)
  })

  it('combines filter and search', async () => {
    mockFind()
    await request(app).get('/api/admin/enrichment?filter=unenriched&q=test')
    const calledFilter = AnimeCache.find.mock.calls[0][0]
    expect(calledFilter.bangumiVersion).toBe(0)
    expect(calledFilter.$or).toBeDefined()
  })
})

describe('POST /api/admin/enrichment/:anilistId/reset', () => {
  const app = buildApp()

  beforeEach(() => jest.clearAllMocks())

  it('returns 404 when anime not found', async () => {
    AnimeCache.findOne = jest.fn().mockResolvedValue(null)
    const res = await request(app).post('/api/admin/enrichment/999/reset')
    expect(res.status).toBe(404)
  })

  it('resets enrichment fields and re-enqueues', async () => {
    const doc = {
      anilistId: 101, titleNative: 'テスト', titleRomaji: 'Test',
      bangumiVersion: 2, titleChinese: '测试', bgmId: 50,
      save: jest.fn().mockResolvedValue(true),
    }
    AnimeCache.findOne = jest.fn().mockResolvedValue(doc)
    enqueueEnrichment.mockImplementation(() => {})

    const res = await request(app).post('/api/admin/enrichment/101/reset')
    expect(res.status).toBe(200)
    expect(res.body.data.reset).toBe(true)
    expect(doc.bangumiVersion).toBe(0)
    expect(doc.titleChinese).toBeNull()
    expect(doc.bgmId).toBeNull()
    expect(doc.save).toHaveBeenCalled()
    expect(enqueueEnrichment).toHaveBeenCalledWith(
      [expect.objectContaining({ anilistId: 101, bangumiVersion: 0 })],
      true
    )
  })

  it('returns 400 for invalid anilistId', async () => {
    const res = await request(app).post('/api/admin/enrichment/abc/reset')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/admin/enrichment/:anilistId/flag', () => {
  const app = buildApp()

  beforeEach(() => jest.clearAllMocks())

  it('sets adminFlag to needs-review', async () => {
    AnimeCache.findOneAndUpdate = jest.fn().mockResolvedValue({ anilistId: 101, adminFlag: 'needs-review' })
    const res = await request(app)
      .post('/api/admin/enrichment/101/flag')
      .send({ flag: 'needs-review' })
    expect(res.status).toBe(200)
    expect(res.body.data.adminFlag).toBe('needs-review')
  })

  it('clears adminFlag with null', async () => {
    AnimeCache.findOneAndUpdate = jest.fn().mockResolvedValue({ anilistId: 101, adminFlag: null })
    const res = await request(app)
      .post('/api/admin/enrichment/101/flag')
      .send({ flag: null })
    expect(res.status).toBe(200)
    expect(res.body.data.adminFlag).toBeNull()
  })

  it('rejects invalid flag value', async () => {
    const res = await request(app)
      .post('/api/admin/enrichment/101/flag')
      .send({ flag: 'invalid' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when anime not found', async () => {
    AnimeCache.findOneAndUpdate = jest.fn().mockResolvedValue(null)
    const res = await request(app)
      .post('/api/admin/enrichment/101/flag')
      .send({ flag: 'needs-review' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/admin/users', () => {
  const app = buildApp()
  beforeEach(() => jest.clearAllMocks())

  function mockUserFind(users = []) {
    User.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(users),
    })
    User.countDocuments = jest.fn().mockResolvedValue(users.length)
    Subscription.aggregate = jest.fn().mockResolvedValue([])
    Follow.aggregate = jest.fn().mockResolvedValue([])
  }

  it('returns paginated user list', async () => {
    mockUserFind([{ _id: 'u1', username: 'alice', email: 'a@test.com', createdAt: new Date() }])
    const res = await request(app).get('/api/admin/users')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].username).toBe('alice')
  })

  it('searches by username', async () => {
    mockUserFind([])
    await request(app).get('/api/admin/users?q=alice')
    const calledFilter = User.find.mock.calls[0][0]
    expect(calledFilter.$or).toBeDefined()
  })
})

describe('POST /api/admin/users', () => {
  const app = buildApp()
  beforeEach(() => jest.clearAllMocks())

  it('creates a new user', async () => {
    User.findOne = jest.fn().mockResolvedValue(null)
    User.create = jest.fn().mockResolvedValue({ _id: 'u2', username: 'bob', email: 'b@test.com' })

    const res = await request(app)
      .post('/api/admin/users')
      .send({ username: 'bob', email: 'b@test.com', password: '123456' })
    expect(res.status).toBe(201)
    expect(res.body.data.username).toBe('bob')
  })

  it('returns 400 when fields are missing', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .send({ username: 'bob' })
    expect(res.status).toBe(400)
  })

  it('returns 409 when username already exists', async () => {
    User.findOne = jest.fn().mockResolvedValue({ username: 'bob' })
    const res = await request(app)
      .post('/api/admin/users')
      .send({ username: 'bob', email: 'new@test.com', password: '123456' })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /api/admin/users/:userId', () => {
  const app = buildApp()
  beforeEach(() => jest.clearAllMocks())

  it('updates user username and email', async () => {
    User.findOne = jest.fn().mockResolvedValue(null)
    User.findByIdAndUpdate = jest.fn().mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'u1', username: 'newname', email: 'new@test.com', role: null, createdAt: new Date() }),
    })

    const res = await request(app)
      .patch('/api/admin/users/u1')
      .send({ username: 'newname', email: 'new@test.com' })
    expect(res.status).toBe(200)
    expect(res.body.data.username).toBe('newname')
  })

  it('returns 400 when no fields provided', async () => {
    const res = await request(app)
      .patch('/api/admin/users/u1')
      .send({})
    expect(res.status).toBe(400)
  })

  it('returns 409 on duplicate', async () => {
    User.findOne = jest.fn().mockResolvedValue({ username: 'taken' })
    const res = await request(app)
      .patch('/api/admin/users/u1')
      .send({ username: 'taken' })
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/admin/users/:userId', () => {
  const app = buildApp()
  beforeEach(() => jest.clearAllMocks())

  it('deletes user and cascades', async () => {
    User.findById = jest.fn().mockResolvedValue({ _id: 'u2', username: 'bob' })
    Subscription.deleteMany = jest.fn().mockResolvedValue({})
    Follow.deleteMany = jest.fn().mockResolvedValue({})
    User.deleteOne = jest.fn().mockResolvedValue({})

    const res = await request(app).delete('/api/admin/users/u2')
    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(true)
    expect(Subscription.deleteMany).toHaveBeenCalled()
    expect(Follow.deleteMany).toHaveBeenCalled()
  })

  it('prevents self-deletion', async () => {
    const res = await request(app).delete('/api/admin/users/user1')
    expect(res.status).toBe(400)
  })

  it('returns 404 when user not found', async () => {
    User.findById = jest.fn().mockResolvedValue(null)
    const res = await request(app).delete('/api/admin/users/u999')
    expect(res.status).toBe(404)
  })
})
