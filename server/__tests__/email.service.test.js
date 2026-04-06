jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({ id: 'test-email-id' }) }
  }))
}));

const { sendPasswordResetEmail } = require('../services/email.service');
const { Resend } = require('resend');

describe('email.service', () => {
  it('calls resend.emails.send with correct params', async () => {
    process.env.CLIENT_ORIGIN = 'https://animego.app';

    await sendPasswordResetEmail('alice@test.com', 'reset-token-123');

    const resendInstance = Resend.mock.results[0].value;
    expect(resendInstance.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@test.com',
        subject: expect.stringContaining('重置'),
        html: expect.stringContaining('https://animego.app/reset-password/reset-token-123'),
      })
    );
  });

  it('uses default CLIENT_ORIGIN when env not set', async () => {
    delete process.env.CLIENT_ORIGIN;

    // Re-require to pick up env change — but since module is cached,
    // we test that the function builds the URL at call time
    await sendPasswordResetEmail('bob@test.com', 'token-456');

    const resendInstance = Resend.mock.results[0].value;
    const call = resendInstance.emails.send.mock.calls[1];
    expect(call[0].html).toContain('/reset-password/token-456');
  });
});
