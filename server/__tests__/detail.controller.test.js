const request = require('supertest')
const express = require('express')

jest.mock('../services/anilist.service', () => ({
  getAnimeDetail: jest.fn(),
}))

jest.mock('../models/AnimeCache', () => ({
  find: jest.fn(),
}))

const anilistService = require('../services/anilist.service')
const AnimeCache = require('../models/AnimeCache')
const detailController = require('../controllers/detail.controller')

function buildApp() {
  const app = express()
  app.get('/api/anime/:anilistId', detailController.getDetail)
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }))
  return app
}

describe('detail.controller', () => {
  let app

  beforeEach(() => {
    app = buildApp()
    jest.clearAllMocks()
  })

  it('returns 400 for non-numeric anilistId', async () => {
    const res = await request(app).get('/api/anime/abc')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns anime detail without relations', async () => {
    anilistService.getAnimeDetail.mockResolvedValue({
      anilistId: 101,
      title: 'Test Anime',
      relations: [],
    })

    const res = await request(app).get('/api/anime/101')
    expect(res.status).toBe(200)
    expect(res.body.data.anilistId).toBe(101)
    expect(AnimeCache.find).not.toHaveBeenCalled()
  })

  it('enriches relations with cached titleChinese and coverImageUrl', async () => {
    anilistService.getAnimeDetail.mockResolvedValue({
      anilistId: 101,
      relations: [
        { anilistId: 201, titleChinese: null, coverImageUrl: null },
        { anilistId: 202, titleChinese: 'Original', coverImageUrl: 'orig.jpg' },
      ],
    })

    AnimeCache.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { anilistId: 201, titleChinese: 'Cached CN', coverImageUrl: 'cached.jpg' },
      ]),
    })

    const res = await request(app).get('/api/anime/101')
    expect(res.status).toBe(200)

    const relations = res.body.data.relations
    // First relation: gets cached values
    expect(relations[0].titleChinese).toBe('Cached CN')
    expect(relations[0].coverImageUrl).toBe('cached.jpg')
    // Second relation: keeps original values (coverImageUrl truthy takes precedence)
    expect(relations[1].titleChinese).toBe('Original')
    expect(relations[1].coverImageUrl).toBe('orig.jpg')
  })

  it('handles null relations gracefully', async () => {
    anilistService.getAnimeDetail.mockResolvedValue({
      anilistId: 101,
      relations: null,
    })

    const res = await request(app).get('/api/anime/101')
    expect(res.status).toBe(200)
    expect(AnimeCache.find).not.toHaveBeenCalled()
  })

  it('passes errors to next()', async () => {
    anilistService.getAnimeDetail.mockRejectedValue(new Error('API down'))

    const res = await request(app).get('/api/anime/101')
    expect(res.status).toBe(500)
  })
})
