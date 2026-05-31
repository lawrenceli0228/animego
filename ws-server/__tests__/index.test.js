// __tests__/index.test.js — sanity checks for the ws-server entrypoint.
//
// We mock the side-effect dependencies (pg, socket.io, danmakuHandler) so
// the test can run on a clean process without a Postgres up.  The mocked
// socket.io captures the connection handler so we can assert the per-packet
// expiry middleware mirrors the legacy server/__tests__/socket.index.test.js
// behavior.

jest.mock('../src/db', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(),
  on: jest.fn(),
}))
jest.mock('../src/socketAuth', () => jest.fn((socket, next) => next()))
jest.mock('../src/danmakuHandler', () => jest.fn())
jest.mock('socket.io', () => {
  const ioInstance = {
    use: jest.fn(),
    on: jest.fn(),
    close: jest.fn((cb) => cb && cb()),
  }
  return {
    Server: jest.fn(() => ioInstance),
    __ioInstance: ioInstance,
  }
})

// Set required env vars before requiring index.js — even though IS_MAIN is
// false under jest (require.main !== module), the createHealthHandler /
// attachSocketIo functions use PORT_WS / CLIENT_ORIGIN at module-eval time.
process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_URL = 'postgres://test'
process.env.PORT_WS = '0' // ephemeral port for any HTTP smoke probe
process.env.CLIENT_ORIGIN = 'http://localhost:3000'

const http = require('http')
const { Server, __ioInstance } = require('socket.io')
const socketAuth = require('../src/socketAuth')
const registerDanmakuHandlers = require('../src/danmakuHandler')
const { createHealthHandler, attachSocketIo } = require('../src/index')

describe('createHealthHandler', () => {
  it('returns 200 ok on GET /health', (done) => {
    const handler = createHealthHandler()
    const server = http.createServer(handler).listen(0, () => {
      const { port } = server.address()
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          expect(res.statusCode).toBe(200)
          expect(body).toBe('ok')
          server.close(done)
        })
      })
    })
  })

  it('also serves /healthz (k8s convention)', (done) => {
    const handler = createHealthHandler()
    const server = http.createServer(handler).listen(0, () => {
      const { port } = server.address()
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        expect(res.statusCode).toBe(200)
        server.close(done)
      })
    })
  })

  it('returns 404 for any non-health path', (done) => {
    const handler = createHealthHandler()
    const server = http.createServer(handler).listen(0, () => {
      const { port } = server.address()
      http.get(`http://127.0.0.1:${port}/anything-else`, (res) => {
        expect(res.statusCode).toBe(404)
        server.close(done)
      })
    })
  })

  it('returns 404 for POST /health (only GET is allowed)', (done) => {
    const handler = createHealthHandler()
    const server = http.createServer(handler).listen(0, () => {
      const { port } = server.address()
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/health', method: 'POST' },
        (res) => {
          expect(res.statusCode).toBe(404)
          server.close(done)
        }
      )
      req.end()
    })
  })
})

describe('attachSocketIo', () => {
  beforeEach(() => {
    Server.mockClear()
    __ioInstance.use.mockClear()
    __ioInstance.on.mockClear()
    registerDanmakuHandlers.mockClear()
  })

  it('constructs Server with CORS scoped to CLIENT_ORIGIN', () => {
    const httpServer = {}
    attachSocketIo(httpServer)
    expect(Server).toHaveBeenCalledWith(
      httpServer,
      expect.objectContaining({
        cors: expect.objectContaining({
          origin: 'http://localhost:3000',
          methods: ['GET', 'POST'],
          credentials: true,
        }),
      })
    )
  })

  it('applies socketAuth via io.use', () => {
    attachSocketIo({})
    expect(__ioInstance.use).toHaveBeenCalledWith(socketAuth)
  })

  it('registers a connection handler that wires danmaku + expiry middleware', () => {
    attachSocketIo({})
    const connectionHandler = __ioInstance.on.mock.calls[0][1]
    const socket = {
      user: { exp: Math.floor(Date.now() / 1000) + 3600 },
      use: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }
    connectionHandler(socket)
    expect(socket.use).toHaveBeenCalledWith(expect.any(Function))
    expect(registerDanmakuHandlers).toHaveBeenCalledWith(__ioInstance, socket)
  })

  it('per-packet middleware emits auth:expired + disconnects on expired token', () => {
    attachSocketIo({})
    const connectionHandler = __ioInstance.on.mock.calls[0][1]
    const socket = {
      user: { exp: Math.floor(Date.now() / 1000) - 10 },
      use: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }
    connectionHandler(socket)
    const perPacketMw = socket.use.mock.calls[0][0]
    const next = jest.fn()
    perPacketMw([], next)
    expect(socket.emit).toHaveBeenCalledWith('auth:expired')
    expect(socket.disconnect).toHaveBeenCalledWith(true)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })

  it('per-packet middleware calls next() for valid tokens', () => {
    attachSocketIo({})
    const connectionHandler = __ioInstance.on.mock.calls[0][1]
    const socket = {
      user: { exp: Math.floor(Date.now() / 1000) + 3600 },
      use: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }
    connectionHandler(socket)
    const perPacketMw = socket.use.mock.calls[0][0]
    const next = jest.fn()
    perPacketMw([], next)
    expect(socket.emit).not.toHaveBeenCalled()
    expect(socket.disconnect).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
  })

  it('returns the io instance', () => {
    const io = attachSocketIo({})
    expect(io).toBe(__ioInstance)
  })
})
