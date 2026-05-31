// __tests__/danmakuHandler.test.js — ported from
// server/__tests__/danmaku.handler.test.js with Mongoose mocks replaced by a
// pg pool mock that asserts SQL shape + bind args.  Same suite layout so a
// reviewer can diff the two files and see the migration is structurally a
// no-op.

jest.mock('../src/db', () => ({
  query: jest.fn(),
}))

const pool = require('../src/db')
const registerDanmakuHandlers = require('../src/danmakuHandler')

function createMockSocket(
  user = {
    userId: '11111111-2222-3333-4444-555555555555',
    username: 'alice',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
) {
  const listeners = {}
  const rooms = new Set(['socket-id'])
  return {
    user,
    rooms,
    on: jest.fn((event, handler) => {
      listeners[event] = handler
    }),
    join: jest.fn((room) => rooms.add(room)),
    leave: jest.fn((room) => rooms.delete(room)),
    emit: jest.fn(),
    _trigger: (event, data) => listeners[event]?.(data),
  }
}

function createMockIo() {
  const emitFn = jest.fn()
  return {
    to: jest.fn(() => ({ emit: emitFn })),
    _emitFn: emitFn,
  }
}

// Helper: assert the SQL passed to pool.query is the episode_windows upsert.
function expectWindowUpsert(callArgs, anilistId, episode) {
  const [sql, params] = callArgs
  expect(sql).toMatch(/INSERT INTO episode_windows/)
  expect(sql).toMatch(/ON CONFLICT \(anilist_id, episode\)/)
  expect(sql).toMatch(/RETURNING live_ends_at/)
  expect(params[0]).toBe(anilistId)
  expect(params[1]).toBe(episode)
  expect(params[2]).toBeInstanceOf(Date)
}

function expectDanmakuInsert(callArgs, expected) {
  const [sql, params] = callArgs
  expect(sql).toMatch(/INSERT INTO danmakus/)
  expect(sql).toMatch(/RETURNING id, created_at/)
  expect(params[0]).toBe(expected.anilistId)
  expect(params[1]).toBe(expected.episode)
  expect(params[2]).toBe(expected.userId)
  expect(params[3]).toBe(expected.username)
  expect(params[4]).toBe(expected.content)
}

describe('danmakuHandler', () => {
  let io, socket
  let userCounter = 0

  beforeEach(() => {
    jest.clearAllMocks()
    registerDanmakuHandlers._clearRateLimitState()
    userCounter++
    io = createMockIo()
    socket = createMockSocket({
      userId: `u${userCounter}`,
      username: 'alice',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    registerDanmakuHandlers(io, socket)
  })

  describe('danmaku:join', () => {
    it('joins the correct room', () => {
      socket._trigger('danmaku:join', { anilistId: 101, episode: 3 })
      expect(socket.join).toHaveBeenCalledWith('danmaku:101:3')
    })

    it('rejects non-numeric anilistId', () => {
      socket._trigger('danmaku:join', { anilistId: 'abc', episode: 1 })
      expect(socket.join).not.toHaveBeenCalled()
    })

    it('rejects negative episode numbers', () => {
      socket._trigger('danmaku:join', { anilistId: 101, episode: -1 })
      expect(socket.join).not.toHaveBeenCalled()
    })

    it('rejects zero episode', () => {
      socket._trigger('danmaku:join', { anilistId: 101, episode: 0 })
      expect(socket.join).not.toHaveBeenCalled()
    })

    it('enforces 10-room limit', () => {
      for (let i = 1; i <= 10; i++) {
        socket.rooms.add(`danmaku:${i}:1`)
      }
      socket._trigger('danmaku:join', { anilistId: 999, episode: 1 })
      expect(socket.emit).toHaveBeenCalledWith(
        'danmaku:error',
        expect.objectContaining({ code: 'ROOM_LIMIT' })
      )
      expect(socket.join).not.toHaveBeenCalled()
    })

    it('accepts string-typed numeric ids (frontend sometimes sends strings)', () => {
      socket._trigger('danmaku:join', { anilistId: '101', episode: '3' })
      expect(socket.join).toHaveBeenCalledWith('danmaku:101:3')
    })
  })

  describe('danmaku:leave', () => {
    it('leaves the correct room', () => {
      socket._trigger('danmaku:leave', { anilistId: 101, episode: 3 })
      expect(socket.leave).toHaveBeenCalledWith('danmaku:101:3')
    })

    it('ignores non-numeric input', () => {
      socket._trigger('danmaku:leave', { anilistId: 'x', episode: 'y' })
      expect(socket.leave).not.toHaveBeenCalled()
    })
  })

  describe('danmaku:send', () => {
    const futureDate = new Date(Date.now() + 3600_000)

    beforeEach(() => {
      // First pool.query call = episode_windows upsert; second = danmakus insert.
      pool.query
        .mockResolvedValueOnce({ rows: [{ live_ends_at: futureDate }] })
        .mockResolvedValueOnce({ rows: [{ id: '42', created_at: new Date('2026-05-23T00:00:00Z') }] })
    })

    it('upserts episode_window then inserts danmaku and broadcasts', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hello' })

      expect(pool.query).toHaveBeenCalledTimes(2)
      expectWindowUpsert(pool.query.mock.calls[0], 101, 1)
      expectDanmakuInsert(pool.query.mock.calls[1], {
        anilistId: 101,
        episode: 1,
        userId: socket.user.userId,
        username: 'alice',
        content: 'Hello',
      })
      expect(io.to).toHaveBeenCalledWith('danmaku:101:1')
      expect(io._emitFn).toHaveBeenCalledWith(
        'danmaku:new',
        expect.objectContaining({
          _id: '42',
          username: 'alice',
          content: 'Hello',
        })
      )
    })

    it('emits _id as a string even if pg returns it as a Number (forward compat)', async () => {
      // The outer beforeEach already queued two mockResolvedValueOnce calls;
      // wipe + re-queue so this test owns the queue end-to-end.
      pool.query.mockReset()
      io._emitFn.mockClear()
      pool.query
        .mockResolvedValueOnce({ rows: [{ live_ends_at: futureDate }] })
        .mockResolvedValueOnce({ rows: [{ id: 9999, created_at: new Date() }] })

      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hi' })

      const newMsg = io._emitFn.mock.calls[0][1]
      expect(typeof newMsg._id).toBe('string')
      expect(newMsg._id).toBe('9999')
    })

    it('trims content to 50 characters', async () => {
      const longContent = 'a'.repeat(100)
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: longContent })

      const insertCall = pool.query.mock.calls.find((c) => /INSERT INTO danmakus/.test(c[0]))
      expect(insertCall[1][4]).toBe('a'.repeat(50))
    })

    it('rejects empty content', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: '' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('rejects whitespace-only content', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: '   \t  ' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('rejects non-string content', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 123 })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('rejects when live window has ended', async () => {
      // Override the queued mock for this test — only the window upsert runs,
      // and it returns a past timestamp so the insert path is skipped.
      pool.query.mockReset()
      pool.query.mockResolvedValueOnce({
        rows: [{ live_ends_at: new Date(Date.now() - 1000) }],
      })

      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Late' })

      expect(pool.query).toHaveBeenCalledTimes(1)
      const insertCall = pool.query.mock.calls.find((c) => /INSERT INTO danmakus/.test(c[0]))
      expect(insertCall).toBeUndefined()
    })

    it('rejects when username is empty', async () => {
      const noNameSocket = createMockSocket({
        userId: `noname${userCounter}`,
        username: '',
        exp: 999999999,
      })
      registerDanmakuHandlers(io, noNameSocket)

      pool.query.mockReset()
      await noNameSocket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hi' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('rejects invalid anilistId in send', async () => {
      pool.query.mockReset()
      await socket._trigger('danmaku:send', { anilistId: 'bad', episode: 1, content: 'Hi' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('rejects negative ids in send', async () => {
      pool.query.mockReset()
      await socket._trigger('danmaku:send', { anilistId: -5, episode: 1, content: 'Hi' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('enforces 5s rate limit per user', async () => {
      // First send completes successfully.
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'First' })
      expect(pool.query).toHaveBeenCalledTimes(2)

      // Second send within the cooldown window must be a no-op.
      pool.query.mockClear()
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Second' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('swallows DB errors without crashing the socket loop', async () => {
      pool.query.mockReset()
      pool.query.mockRejectedValueOnce(new Error('connection lost'))

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      await expect(
        socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hi' })
      ).resolves.not.toThrow()
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })

    it('passes a future Date as the window upsert third bind ($3)', async () => {
      const before = Date.now()
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hello' })
      const upsertCall = pool.query.mock.calls[0]
      const livenessParam = upsertCall[1][2]
      expect(livenessParam).toBeInstanceOf(Date)
      // Must be at least ~2h in the future (allow ±1s slop for test timing).
      const expected = before + 2 * 60 * 60 * 1000
      expect(livenessParam.getTime()).toBeGreaterThanOrEqual(expected - 1000)
      expect(livenessParam.getTime()).toBeLessThanOrEqual(expected + 1000)
    })
  })
})
