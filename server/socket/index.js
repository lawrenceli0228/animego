const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const socketAuth = require('../middleware/socketAuth');
const registerDanmakuHandlers = require('./danmaku.handler');

module.exports = function setupSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.use(socketAuth);

  io.on('connection', (socket) => {
    // Re-verify JWT on each event so expired tokens don't linger
    socket.use((packet, next) => {
      try {
        jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
        next();
      } catch (err) {
        if (err.name === 'TokenExpiredError') socket.emit('auth:expired');
        socket.disconnect(true);
      }
    });

    registerDanmakuHandlers(io, socket);
  });

  return io;
};
