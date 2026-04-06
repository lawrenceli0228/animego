const jwt = require('jsonwebtoken');

// Set JWT_SECRET before requiring the middleware
process.env.JWT_SECRET = 'test-secret';

const { authenticateToken, optionalAuth } = require('../middleware/auth.middleware');

function mockReqResNext() {
  const req = { headers: {} };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('authenticateToken', () => {
  it('returns 401 when no Authorization header', () => {
    const { req, res, next } = mockReqResNext();
    authenticateToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'NO_TOKEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header has no token', () => {
    const { req, res, next } = mockReqResNext();
    req.headers['authorization'] = 'Bearer ';
    authenticateToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('sets req.user and calls next on valid token', () => {
    const { req, res, next } = mockReqResNext();
    const token = jwt.sign({ userId: '123', username: 'alice' }, process.env.JWT_SECRET);
    req.headers['authorization'] = `Bearer ${token}`;
    authenticateToken(req, res, next);
    expect(req.user).toMatchObject({ userId: '123', username: 'alice' });
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(err) on invalid token', () => {
    const { req, res, next } = mockReqResNext();
    req.headers['authorization'] = 'Bearer invalid.token.here';
    authenticateToken(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('calls next(err) on expired token', () => {
    const { req, res, next } = mockReqResNext();
    const token = jwt.sign({ userId: '123' }, process.env.JWT_SECRET, { expiresIn: '0s' });
    req.headers['authorization'] = `Bearer ${token}`;
    // Small delay to ensure expiry
    authenticateToken(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('optionalAuth', () => {
  it('calls next without setting req.user when no token', () => {
    const { req, res, next } = mockReqResNext();
    optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('sets req.user on valid token', () => {
    const { req, res, next } = mockReqResNext();
    const token = jwt.sign({ userId: '456', username: 'bob' }, process.env.JWT_SECRET);
    req.headers['authorization'] = `Bearer ${token}`;
    optionalAuth(req, res, next);
    expect(req.user).toMatchObject({ userId: '456', username: 'bob' });
    expect(next).toHaveBeenCalled();
  });

  it('continues without error on invalid token', () => {
    const { req, res, next } = mockReqResNext();
    req.headers['authorization'] = 'Bearer bad-token';
    optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
