jest.mock('../services/dandanplay.service')
jest.mock('../services/bangumi.service')
jest.mock('../models/AnimeCache')

const dandanplay = require('../services/dandanplay.service')
const bangumi = require('../services/bangumi.service')
const AnimeCache = require('../models/AnimeCache')
const ctrl = require('../controllers/dandanplay.controller')

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

function callMatch(body) {
  const req = { body }
  const res = makeRes()
  const next = jest.fn()
  return ctrl.match(req, res, next).then(() => ({ res, next }))
}

const epDataFixture = {
  title: '秋叶原女仆战争',
  imageUrl: 'http://img.test/cover.jpg',
  episodes: [
    { dandanEpisodeId: 101, title: '第1话', number: 1 },
  ],
}

const cacheDocFixture = {
  anilistId: 143270,
  titleChinese: '秋叶原女仆战争',
  titleNative: 'アキバ冥途戦争',
  titleRomaji: 'Akiba Maid Sensou',
  coverImageUrl: 'http://anilist/cover.jpg',
  episodes: 12,
  averageScore: 72,
  format: 'TV',
  bgmId: 378862,
}

describe('dandanplay.controller match() — Phase 1 enrichment fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    dandanplay.matchCombined.mockResolvedValue({
      isMatched: true, animeId: 17000, animeTitle: '秋叶原女仆战争',
      episodeId: 101, episodeTitle: '第1话',
    })
    dandanplay.fetchDandanEpisodesByAnimeId.mockResolvedValue(epDataFixture)
    dandanplay.buildEpisodeMap.mockReturnValue({ 1: { dandanEpisodeId: 101, title: '第1话' } })
  })

  it('fills siteAnime when dandanplay title hits AnimeCache', async () => {
    dandanplay.searchAnimeCache.mockResolvedValueOnce([cacheDocFixture])
    const { res } = await callMatch({
      keyword: 'Akiba Maid Sensou', episodes: [1], fileName: 'file.mkv', files: [],
    })
    expect(res.body.matched).toBe(true)
    expect(res.body.siteAnime.anilistId).toBe(143270)
    expect(dandanplay.searchAnimeCache).toHaveBeenCalledTimes(1)
    expect(dandanplay.searchAnimeCache).toHaveBeenCalledWith('秋叶原女仆战争')
  })

  it('REGRESSION: falls back to user keyword when dandanplay title misses cache', async () => {
    dandanplay.searchAnimeCache
      .mockResolvedValueOnce([])             // title miss
      .mockResolvedValueOnce([cacheDocFixture]) // keyword hit
    const { res } = await callMatch({
      keyword: 'Akiba Maid Sensou', episodes: [1], fileName: 'file.mkv', files: [],
    })
    expect(res.body.siteAnime.anilistId).toBe(143270)
    expect(dandanplay.searchAnimeCache).toHaveBeenNthCalledWith(1, '秋叶原女仆战争')
    expect(dandanplay.searchAnimeCache).toHaveBeenNthCalledWith(2, 'Akiba Maid Sensou')
  })

  it('falls back to bangumi.tv bgmId → AnimeCache.findOne when both title searches miss', async () => {
    dandanplay.searchAnimeCache.mockResolvedValue([])
    bangumi.fetchBangumiData.mockResolvedValue({ titleChinese: null, bgmId: 378862 })
    AnimeCache.findOne.mockReturnValue({ lean: () => Promise.resolve(cacheDocFixture) })

    const { res } = await callMatch({
      keyword: 'Akiba Maid Sensou', episodes: [1], fileName: 'file.mkv', files: [],
    })
    expect(res.body.siteAnime.anilistId).toBe(143270)
    expect(AnimeCache.findOne).toHaveBeenCalledWith({ bgmId: 378862 })
  })

  it('returns matched:true with siteAnime:null when all fallbacks miss', async () => {
    dandanplay.searchAnimeCache.mockResolvedValue([])
    bangumi.fetchBangumiData.mockResolvedValue(null)

    const { res } = await callMatch({
      keyword: 'Unknown Title', episodes: [1], fileName: 'file.mkv', files: [],
    })
    expect(res.body.matched).toBe(true)
    expect(res.body.siteAnime).toBeNull()
  })

  it('swallows fetchBangumiData errors and returns siteAnime:null', async () => {
    dandanplay.searchAnimeCache.mockResolvedValue([])
    bangumi.fetchBangumiData.mockRejectedValue(new Error('bgm.tv 500'))

    const { res, next } = await callMatch({
      keyword: 'Foo', episodes: [1], fileName: 'file.mkv', files: [],
    })
    expect(res.body.matched).toBe(true)
    expect(res.body.siteAnime).toBeNull()
    expect(next).not.toHaveBeenCalled()
  })

  it('times out bangumi.tv lookup after 2s, returns siteAnime:null', async () => {
    dandanplay.searchAnimeCache.mockResolvedValue([])
    // Never resolves — simulates a hang; timeout wrapper should win the race
    bangumi.fetchBangumiData.mockReturnValue(new Promise(() => {}))

    const start = Date.now()
    const { res } = await callMatch({
      keyword: 'Slow', episodes: [1], fileName: 'file.mkv', files: [],
    })
    const elapsed = Date.now() - start

    expect(res.body.matched).toBe(true)
    expect(res.body.siteAnime).toBeNull()
    // Should resolve near the 2s cap, not hang. Allow generous upper bound for CI.
    expect(elapsed).toBeGreaterThanOrEqual(1900)
    expect(elapsed).toBeLessThan(4000)
  }, 10000)
})
