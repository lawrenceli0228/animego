const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: err.message }
    });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({
      error: { code: 'DUPLICATE_ERROR', message: `${field} 已存在` }
    });
  }
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: '无效的 token' }
    });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: { code: 'TOKEN_EXPIRED', message: 'token 已过期' }
    });
  }

  const message = process.env.NODE_ENV === 'production'
    ? '服务器错误'
    : (err.message || '服务器错误');
  res.status(err.status || 500).json({
    error: { code: 'SERVER_ERROR', message }
  });
};

module.exports = errorHandler;
