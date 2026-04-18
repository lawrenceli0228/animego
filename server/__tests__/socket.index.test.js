jest.mock('socket.io', () => {
  const ioInstance = {
    use: jest.fn(),
    on: jest.fn(),
  };
  return {
    Server: jest.fn(() => ioInstance),
    __ioInstance: ioInstance,
  };
});
jest.mock('../middleware/socketAuth', () => jest.fn((socket, next) => next()));
jest.mock('../socket/danmaku.handler', () => jest.fn());

const { Server, __ioInstance } = require('socket.io');
const socketAuth = require('../middleware/socketAuth');
const registerDanmakuHandlers = require('../socket/danmaku.handler');
const setupSocket = require('../socket');

describe('socket/index (setupSocket)', () => {
  beforeEach(() => {
    Server.mockClear();
    __ioInstance.use.mockClear();
    __ioInstance.on.mockClear();
    registerDanmakuHandlers.mockClear();
    delete process.env.CLIENT_ORIGIN;
  });

  it('creates a Server with default cors origin when CLIENT_ORIGIN unset', () => {
    const httpServer = {};
    setupSocket(httpServer);
    expect(Server).toHaveBeenCalledWith(httpServer, expect.objectContaining({
      cors: expect.objectContaining({
        origin: 'http://localhost:5173',
        methods: ['GET', 'POST'],
        credentials: true,
      }),
    }));
  });

  it('uses CLIENT_ORIGIN env when provided', () => {
    process.env.CLIENT_ORIGIN = 'https://example.com';
    setupSocket({});
    expect(Server).toHaveBeenCalledWith({}, expect.objectContaining({
      cors: expect.objectContaining({ origin: 'https://example.com' }),
    }));
  });

  it('applies socketAuth middleware via io.use', () => {
    setupSocket({});
    expect(__ioInstance.use).toHaveBeenCalledWith(socketAuth);
  });

  it('registers a connection handler', () => {
    setupSocket({});
    expect(__ioInstance.on).toHaveBeenCalledWith('connection', expect.any(Function));
  });

  it('on connection, attaches expiry middleware and registers danmaku handlers', () => {
    setupSocket({});
    const connectionHandler = __ioInstance.on.mock.calls[0][1];
    const socket = {
      user: { exp: Math.floor(Date.now() / 1000) + 3600 },
      use: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    connectionHandler(socket);
    expect(socket.use).toHaveBeenCalledWith(expect.any(Function));
    expect(registerDanmakuHandlers).toHaveBeenCalledWith(__ioInstance, socket);
  });

  it('expiry middleware disconnects + emits auth:expired when token expired', () => {
    setupSocket({});
    const connectionHandler = __ioInstance.on.mock.calls[0][1];
    const socket = {
      user: { exp: Math.floor(Date.now() / 1000) - 10 },
      use: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    connectionHandler(socket);
    const perPacketMw = socket.use.mock.calls[0][0];
    const next = jest.fn();
    perPacketMw([], next);
    expect(socket.emit).toHaveBeenCalledWith('auth:expired');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('expiry middleware calls next() for valid tokens', () => {
    setupSocket({});
    const connectionHandler = __ioInstance.on.mock.calls[0][1];
    const socket = {
      user: { exp: Math.floor(Date.now() / 1000) + 3600 },
      use: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    connectionHandler(socket);
    const perPacketMw = socket.use.mock.calls[0][0];
    const next = jest.fn();
    perPacketMw([], next);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('returns the io instance', () => {
    const io = setupSocket({});
    expect(io).toBe(__ioInstance);
  });
});
