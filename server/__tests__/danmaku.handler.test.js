jest.mock('../models/Danmaku', () => ({
  create: jest.fn(),
}))

jest.mock('../models/EpisodeWindow', () => ({
  findOneAndUpdate: jest.fn(),
}))

const Danmaku = require('../models/Danmaku')
const EpisodeWindow = require('../models/EpisodeWindow')
const registerDanmakuHandlers = require('../socket/danmaku.handler')

function createMockSocket(user = { userId: 'u1', username: 'alice', exp: Math.floor(Date.now() / 1000) + 3600 }) {
  const listeners = {}
  const rooms = new Set(['socket-id'])
  return {
    user,
    rooms,
    on: jest.fn((event, handler) => { listeners[event] = handler }),
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

describe('danmaku.handler', () => {
  let io, socket
  let userCounter = 0

  beforeEach(() => {
    jest.clearAllMocks()
    // Use unique userId per test to avoid module-level rate-limit Map collision
    userCounter++
    io = createMockIo()
    socket = createMockSocket({ userId: `u${userCounter}`, username: 'alice', exp: Math.floor(Date.now() / 1000) + 3600 })
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

    it('enforces 10-room limit', () => {
      // Fill up 10 danmaku rooms
      for (let i = 1; i <= 10; i++) {
        socket.rooms.add(`danmaku:${i}:1`)
      }

      socket._trigger('danmaku:join', { anilistId: 999, episode: 1 })
      expect(socket.emit).toHaveBeenCalledWith('danmaku:error', expect.objectContaining({ code: 'ROOM_LIMIT' }))
      expect(socket.join).not.toHaveBeenCalled()
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
      EpisodeWindow.findOneAndUpdate.mockResolvedValue({ liveEndsAt: futureDate })
      Danmaku.create.mockResolvedValue({
        _id: 'd1',
        username: 'alice',
        content: 'Hello',
        createdAt: new Date(),
      })
    })

    it('creates danmaku and broadcasts to room', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hello' })

      expect(EpisodeWindow.findOneAndUpdate).toHaveBeenCalled()
      expect(Danmaku.create).toHaveBeenCalledWith(
        expect.objectContaining({
          anilistId: 101,
          episode: 1,
          content: 'Hello',
          username: 'alice',
        })
      )
      expect(io.to).toHaveBeenCalledWith('danmaku:101:1')
      expect(io._emitFn).toHaveBeenCalledWith('danmaku:new', expect.objectContaining({
        _id: 'd1',
        username: 'alice',
        content: 'Hello',
      }))
    })

    it('trims content to 50 characters', async () => {
      const longContent = 'a'.repeat(100)
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: longContent })

      expect(Danmaku.create).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'a'.repeat(50) })
      )
    })

    it('rejects empty content', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: '' })
      expect(Danmaku.create).not.toHaveBeenCalled()
    })

    it('rejects non-string content', async () => {
      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 123 })
      expect(Danmaku.create).not.toHaveBeenCalled()
    })

    it('rejects when live window has ended', async () => {
      EpisodeWindow.findOneAndUpdate.mockResolvedValue({
        liveEndsAt: new Date(Date.now() - 1000),
      })

      await socket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Late' })
      expect(Danmaku.create).not.toHaveBeenCalled()
    })

    it('rejects when username is empty', async () => {
      const noNameSocket = createMockSocket({ userId: `noname${userCounter}`, username: '', exp: 999999999 })
      registerDanmakuHandlers(io, noNameSocket)

      await noNameSocket._trigger('danmaku:send', { anilistId: 101, episode: 1, content: 'Hi' })
      expect(Danmaku.create).not.toHaveBeenCalled()
    })

    it('rejects invalid anilistId in send', async () => {
      await socket._trigger('danmaku:send', { anilistId: 'bad', episode: 1, content: 'Hi' })
      expect(Danmaku.create).not.toHaveBeenCalled()
    })
  })
})
