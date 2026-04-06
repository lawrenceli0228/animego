const errorHandler = require('../middleware/errorHandler');

function mockReqResNext() {
  const req = {};
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

// Suppress console.error output during tests
beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { console.error.mockRestore(); });

describe('errorHandler', () => {
  it('returns 400 for ValidationError', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error('field is required');
    err.name = 'ValidationError';
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'VALIDATION_ERROR', message: 'field is required' }
    });
  });

  it('returns 400 for duplicate key error (code 11000)', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error('duplicate');
    err.code = 11000;
    err.keyValue = { email: 'test@test.com' };
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'DUPLICATE_ERROR', message: 'email 已存在' }
    });
  });

  it('returns 401 for JsonWebTokenError', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error('jwt malformed');
    err.name = 'JsonWebTokenError';
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INVALID_TOKEN', message: '无效的 token' }
    });
  });

  it('returns 401 for TokenExpiredError', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'TOKEN_EXPIRED', message: 'token 已过期' }
    });
  });

  it('returns custom status when err.status is set', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error('forbidden');
    err.status = 403;
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'SERVER_ERROR', message: 'forbidden' }
    });
  });

  it('defaults to 500 for unknown errors', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error('something broke');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'SERVER_ERROR', message: 'something broke' }
    });
  });

  it('uses fallback message when err.message is empty', () => {
    const { req, res, next } = mockReqResNext();
    const err = new Error();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'SERVER_ERROR', message: '服务器错误' }
    });
  });
});
