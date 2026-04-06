const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';

const socketAuth = require('../middleware/socketAuth');

describe('socketAuth middleware', () => {
  it('calls next with error when no token provided', () => {
    const socket = { handshake: { auth: {} } };
    const next = jest.fn();
    socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }));
  });

  it('sets socket.user and calls next on valid token', () => {
    const token = jwt.sign({ userId: '123', username: 'alice' }, process.env.JWT_SECRET);
    const socket = { handshake: { auth: { token } } };
    const next = jest.fn();
    socketAuth(socket, next);
    expect(socket.user).toMatchObject({ userId: '123', username: 'alice' });
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next with error on invalid token', () => {
    const socket = { handshake: { auth: { token: 'bad-token' } } };
    const next = jest.fn();
    socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid token' }));
  });
});
