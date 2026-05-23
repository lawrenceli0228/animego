module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  // Force exit if open handles keep the process alive (socket.io tests).
  forceExit: true,
  // Detect hanging timers/sockets that would otherwise be silenced by forceExit.
  detectOpenHandles: false,
}
