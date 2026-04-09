module.exports = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权限' } });
  }
  next();
};
