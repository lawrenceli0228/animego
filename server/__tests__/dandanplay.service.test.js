jest.mock('../models/AnimeCache')
jest.mock('../utils/rateLimitedFetch')

const AnimeCache = require('../models/AnimeCache')
const { createRateLimitedFetch } = require('../utils/rateLimitedFetch')

// Mock dandanFetch
const mockFetch = jest.fn()
createRateLimitedFetch.mockReturnValue(mockFetch)

const dandanplay = require('../services/dandanplay.service')

describe('dandanplay.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── searchAnimeCache ──────────────────────────────────────────────────────

  describe('searchAnimeCache', () => {
    it('returns empty array for empty keyword', async () => {
      const result = await dandanplay.searchAnimeCache('')
      expect(result).toEqual([])
      expect(AnimeCache.find).not.toHaveBeenCalled()
    })

    it('searches AnimeCache with regex and returns results', async () => {
      const mockResults = [{ titleChinese: '进击的巨人' }]
      AnimeCache.find.mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mockResults),
        }),
      })

      const result = await dandanplay.searchAnimeCache('进击')
      expect(result).toEqual(mockResults)
      expect(AnimeCache.find).toHaveBeenCalledTimes(1)
    })

    it('strips punctuation between tokens so `:`/`-`/`~` variants all match', async () => {
      // After punctuation tolerance, "Kaguya-sama wa Kokurasetai - Otona e no Kaidan"
      // and "Kaguya-sama wa Kokurasetai: Otona e no Kaidan" produce the same token
      // sequence and the regex should match the colon-separated cache title.
      AnimeCache.find.mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      })
      await dandanplay.searchAnimeCache('Kaguya-sama wa Kokurasetai - Otona e no Kaidan')
      const regex = AnimeCache.find.mock.calls[0][0].$or[0].titleChinese
      expect(regex.test('Kaguya-sama wa Kokurasetai: Otona e no Kaidan')).toBe(true)
      expect(regex.test('Kaguya~sama~wa~Kokurasetai~Otona~e~no~Kaidan')).toBe(true)
      // Token order still matters — shuffled tokens must not match.
      expect(regex.test('Otona e no Kaidan Kaguya')).toBe(false)
    })

    it('returns empty result when keyword has no word characters', async () => {
      const result = await dandanplay.searchAnimeCache('---:::')
      expect(result).toEqual([])
      expect(AnimeCache.find).not.toHaveBeenCalled()
    })
  })

  // ── fetchDandanEpisodes ───────────────────────────────────────────────────

  describe('fetchDandanEpisodes', () => {
    it('returns episode data from API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          bangumi: {
            animeId: 100,
            animeTitle: 'Test Anime',
            imageUrl: 'http://img.test/cover.jpg',
            episodes: [
              { episodeId: 1001, episodeTitle: '第1話' },
              { episodeId: 1002, episodeTitle: '第2話' },
            ],
          },
        }),
      })

      const result = await dandanplay.fetchDandanEpisodes(12345)
      expect(result.dandanAnimeId).toBe(100)
      expect(result.title).toBe('Test Anime')
      expect(result.episodes).toHaveLength(2)
      expect(result.episodes[0].number).toBe(1)
    })

    it('returns null when API returns not ok', async () => {
      mockFetch.mockResolvedValue({ ok: false })
      const result = await dandanplay.fetchDandanEpisodes(99999)
      expect(result).toBeNull()
    })

    it('returns null when bangumi data is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ bangumi: null }),
      })
      const result = await dandanplay.fetchDandanEpisodes(99999)
      expect(result).toBeNull()
    })
  })

  // ── matchByFileName ───────────────────────────────────────────────────────

  describe('matchByFileName', () => {
    it('returns match result on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          isMatched: true,
          matches: [{
            animeId: 200,
            animeTitle: 'Matched Anime',
            episodeId: 2001,
            episodeTitle: '第5話',
          }],
        }),
      })

      const result = await dandanplay.matchByFileName('[Sub] Anime - 05.mkv')
      expect(result.animeId).toBe(200)
      expect(result.animeTitle).toBe('Matched Anime')
    })

    it('returns null when not matched', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ isMatched: false, matches: [] }),
      })

      const result = await dandanplay.matchByFileName('random_file.mkv')
      expect(result).toBeNull()
    })

    it('returns null on API failure', async () => {
      mockFetch.mockResolvedValue({ ok: false })
      const result = await dandanplay.matchByFileName('file.mkv')
      expect(result).toBeNull()
    })
  })

  // ── fetchComments ─────────────────────────────────────────────────────────

  describe('fetchComments', () => {
    it('returns comments from API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          count: 2,
          comments: [
            { p: '10,1,16777215', m: 'hello' },
            { p: '20,4,255', m: 'world' },
          ],
        }),
      })

      const result = await dandanplay.fetchComments(3001)
      expect(result.count).toBe(2)
      expect(result.comments).toHaveLength(2)
    })

    it('returns empty on API failure', async () => {
      mockFetch.mockResolvedValue({ ok: false })
      const result = await dandanplay.fetchComments(9999)
      expect(result).toEqual({ count: 0, comments: [] })
    })
  })

  // ── buildEpisodeMap ───────────────────────────────────────────────────────

  describe('buildEpisodeMap', () => {
    it('maps requested episodes to dandan episodes', () => {
      const dandanEpisodes = [
        { dandanEpisodeId: 5001, title: '第1話', number: 1 },
        { dandanEpisodeId: 5002, title: '第2話', number: 2 },
        { dandanEpisodeId: 5003, title: '第3話', number: 3 },
      ]

      const map = dandanplay.buildEpisodeMap(dandanEpisodes, [1, 3])
      expect(map[1].dandanEpisodeId).toBe(5001)
      expect(map[3].dandanEpisodeId).toBe(5003)
      expect(map[2]).toBeUndefined()
    })

    it('returns empty map when no episodes match', () => {
      const dandanEpisodes = [
        { dandanEpisodeId: 5001, title: '第1話', number: 1 },
      ]

      const map = dandanplay.buildEpisodeMap(dandanEpisodes, [10, 11])
      expect(Object.keys(map)).toHaveLength(0)
    })
  })
})
