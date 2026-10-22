// __tests__/socketAuth.test.js — ported from server/__tests__/socketAuth.test.js.
// Same test set as Express because the middleware is byte-for-byte identical;
// any drift here means JWT cross-stack interop has silently regressed.

const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = 'test-secret'

jest.mock('../src/db', () => ({
  query: jest.fn(),
}))

const pool = require('../src/db')
const socketAuth = require('../src/socketAuth')

describe('socketAuth middleware', () => {
  it('calls next with error when no token provided', () => {
    const socket = { handshake: { auth: {} } }
    const next = jest.fn()
    socketAuth(socket, next)
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Authentication required' })
    )
  })

  it('sets socket.user and calls next on valid token', () => {
    const token = jwt.sign(
      { userId: '11111111-2222-3333-4444-555555555555', username: 'alice' },
      process.env.JWT_SECRET
    )
    const socket = { handshake: { auth: { token } } }
    const next = jest.fn()
    socketAuth(socket, next)
    expect(socket.user).toMatchObject({
      userId: '11111111-2222-3333-4444-555555555555',
      username: 'alice',
    })
    expect(next).toHaveBeenCalledWith()
  })

  it('calls next with error on invalid token', () => {
    const socket = { handshake: { auth: { token: 'bad-token' } } }
    const next = jest.fn()
    socketAuth(socket, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid token' }))
  })

  it('rejects token signed with a different secret', () => {
    const token = jwt.sign({ userId: 'x', username: 'eve' }, 'a-different-secret')
    const socket = { handshake: { auth: { token } } }
    const next = jest.fn()
    socketAuth(socket, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid token' }))
  })

  it('preserves exp claim on socket.user for the per-packet re-check', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const token = jwt.sign({ userId: 'u1', username: 'alice', exp }, process.env.JWT_SECRET)
    const socket = { handshake: { auth: { token } } }
    const next = jest.fn()
    socketAuth(socket, next)
    expect(socket.user.exp).toBe(exp)
  })
})

// go-api refuses an access token whose session has ended — the device was
// signed out from another device's settings page, logged out, or its
// password changed. This channel writes as the user, so it must refuse the
// same token instead of honouring it until it expires.
describe('socketAuth: the session behind the token', () => {
  const sign = (claims) =>
    jwt.sign({ userId: 'u1', username: 'alice', ...claims }, process.env.JWT_SECRET)
  const run = (token) =>
    new Promise((resolve) => {
      const socket = { handshake: { auth: { token } } }
      socketAuth(socket, (err) => resolve({ socket, err }))
    })

  beforeEach(() => pool.query.mockReset())

  it('lets a token in while its session is live', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ live: true }] })

    const { socket, err } = await run(sign({ sid: 's-1' }))

    expect(err).toBeUndefined()
    expect(socket.user).toMatchObject({ userId: 'u1', sid: 's-1' })
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/FROM user_sessions/), ['s-1', 'u1'])
  })

  it('refuses a token whose session has ended', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ live: false }] })

    const { socket, err } = await run(sign({ sid: 's-1' }))

    expect(err).toEqual(expect.objectContaining({ message: 'Invalid token' }))
    expect(socket.user).toBeUndefined()
  })

  it('refuses when the session cannot be looked up', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'))

    const { socket, err } = await run(sign({ sid: 's-1' }))

    expect(err).toBeInstanceOf(Error)
    expect(socket.user).toBeUndefined()
  })

  it('does not look up a token minted before tokens named their session', async () => {
    const { socket, err } = await run(sign({}))

    expect(err).toBeUndefined()
    expect(socket.user.username).toBe('alice')
    expect(pool.query).not.toHaveBeenCalled()
  })
})

