const { Server } = require('socket.io');
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
    // Lightweight per-event expiry check (avoids full jwt.verify on every packet)
    socket.use((packet, next) => {
      if (socket.user?.exp && socket.user.exp * 1000 < Date.now()) {
        socket.emit('auth:expired');
        socket.disconnect(true);
        return next(new Error('token expired'));
      }
      next();
    });

    registerDanmakuHandlers(io, socket);
  });

  return io;
};
