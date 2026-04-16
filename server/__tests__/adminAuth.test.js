const adminAuth = require('../middleware/adminAuth')

function mockReqResNext(role) {
  const req = { user: role ? { role } : undefined }
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  const next = jest.fn()
  return { req, res, next }
}

describe('adminAuth middleware', () => {
  it('returns 403 when user has no admin role', () => {
    const { req, res, next } = mockReqResNext('user')
    adminAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 403 when req.user is undefined', () => {
    const { req, res, next } = mockReqResNext(null)
    req.user = undefined
    adminAuth(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('calls next() for admin users', () => {
    const { req, res, next } = mockReqResNext('admin')
    adminAuth(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })
})
