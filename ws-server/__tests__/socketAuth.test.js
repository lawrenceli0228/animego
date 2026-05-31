// __tests__/socketAuth.test.js — ported from server/__tests__/socketAuth.test.js.
// Same test set as Express because the middleware is byte-for-byte identical;
// any drift here means JWT cross-stack interop has silently regressed.

const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = 'test-secret'

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
