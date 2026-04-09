jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  }),
}));

process.env.GMAIL_USER = 'test@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'test-app-password';

const { sendPasswordResetEmail } = require('../services/email.service');
const nodemailer = require('nodemailer');

describe('email.service', () => {
  it('calls sendMail with correct params', async () => {
    process.env.CLIENT_ORIGIN = 'https://animegoclub.com';

    await sendPasswordResetEmail('alice@test.com', 'reset-token-123');

    const transport = nodemailer.createTransport.mock.results[0].value;
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@test.com',
        subject: expect.stringContaining('重置'),
        html: expect.stringContaining('https://animegoclub.com/reset-password/reset-token-123'),
      })
    );
  });

  it('uses default CLIENT_ORIGIN when env not set', async () => {
    delete process.env.CLIENT_ORIGIN;

    await sendPasswordResetEmail('bob@test.com', 'token-456');

    const transport = nodemailer.createTransport.mock.results[0].value;
    const call = transport.sendMail.mock.calls[1];
    expect(call[0].html).toContain('/reset-password/token-456');
  });
});
