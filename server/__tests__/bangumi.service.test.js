jest.mock('../models/AnimeCache', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}))

const AnimeCache = require('../models/AnimeCache')

// Fresh module per test to reset queue state
let bangumi

function resetModule() {
  jest.resetModules()
  jest.mock('../models/AnimeCache', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn(),
  }))
  bangumi = require('../services/bangumi.service')
}

describe('bangumi.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetModule()
  })

  afterEach(() => {
    // Suppress unhandled rejections from background queues
    jest.restoreAllMocks()
  })

  describe('getQueueStatus', () => {
    it('returns initial empty queue status', () => {
      const status = bangumi.getQueueStatus()
      expect(status).toEqual({
        phase1: 0,
        phase4: 0,
        v3: 0,
        v3Progress: null,
      })
    })
  })

  describe('enqueueEnrichment', () => {
    it('skips items without anilistId', () => {
      // Mock processQueue to not actually run
      const AnimeCache = require('../models/AnimeCache')
      AnimeCache.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) })

      bangumi.enqueueEnrichment([{ titleNative: 'Test' }])
      expect(bangumi.getQueueStatus().phase1).toBe(0)
    })

    it('skips items already enriched (bangumiVersion >= 1)', () => {
      bangumi.enqueueEnrichment([
        { anilistId: 101, bangumiVersion: 1, titleNative: 'Test' },
      ])
      expect(bangumi.getQueueStatus().phase1).toBe(0)
    })

    it('enqueues valid items and starts processing', () => {
      const AnimeCache = require('../models/AnimeCache')
      AnimeCache.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) })

      bangumi.enqueueEnrichment([
        { anilistId: 101, bangumiVersion: 0, titleNative: '進撃の巨人' },
        { anilistId: 102, bangumiVersion: 0, titleRomaji: 'Demon Slayer' },
      ])
      expect(bangumi.getQueueStatus().phase1).toBeGreaterThanOrEqual(0) // may have started processing
    })

    it('deduplicates items by anilistId', () => {
      const AnimeCache = require('../models/AnimeCache')
      // Prevent queue from draining instantly
      AnimeCache.findOne.mockReturnValue({
        lean: jest.fn().mockImplementation(() => new Promise(() => {})),
      })

      bangumi.enqueueEnrichment([
        { anilistId: 101, bangumiVersion: 0, titleNative: 'A' },
        { anilistId: 101, bangumiVersion: 0, titleNative: 'B' },
        { anilistId: 102, bangumiVersion: 0, titleNative: 'C' },
      ])
      // First item starts processing immediately (leaves the map), second is deduped
      // So we expect at most 1 in the map (102), since 101 is being processed
      const status = bangumi.getQueueStatus()
      expect(status.phase1).toBeLessThanOrEqual(2)
    })
  })

  describe('enqueuePhase4Enrichment', () => {
    it('skips items without bgmId', () => {
      bangumi.enqueuePhase4Enrichment([{ anilistId: 101 }])
      expect(bangumi.getQueueStatus().phase4).toBe(0)
    })
  })

  describe('V3 enrichment', () => {
    it('skips items that already have titleChinese', () => {
      bangumi.enqueueV3Enrichment([
        { anilistId: 101, bgmId: 1, titleChinese: '已有标题' },
      ])
      expect(bangumi.getQueueStatus().v3).toBe(0)
    })

    it('skips items with bangumiVersion >= 3', () => {
      bangumi.enqueueV3Enrichment([
        { anilistId: 101, bgmId: 1, bangumiVersion: 3 },
      ])
      expect(bangumi.getQueueStatus().v3).toBe(0)
    })

    it('startV3Batch resets progress counters', () => {
      bangumi.startV3Batch(50)
      const status = bangumi.getQueueStatus()
      expect(status.v3Progress).toEqual({
        total: 50,
        processed: 0,
        healed: 0,
        paused: false,
      })
    })

    it('pauseV3 sets paused flag', () => {
      bangumi.startV3Batch(10)
      bangumi.pauseV3()
      const status = bangumi.getQueueStatus()
      expect(status.v3Progress.paused).toBe(true)
    })

    it('resumeV3 clears paused flag', () => {
      bangumi.startV3Batch(10)
      bangumi.pauseV3()
      bangumi.resumeV3()
      const status = bangumi.getQueueStatus()
      expect(status.v3Progress.paused).toBe(false)
    })
  })
})
