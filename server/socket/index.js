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
    registerDanmakuHandlers(io, socket);
  });

  return io;
};
