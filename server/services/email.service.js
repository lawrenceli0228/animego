const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send password reset email
 * @param {string} to - recipient email
 * @param {string} token - reset token
 */
exports.sendPasswordResetEmail = async (to, token) => {
  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  const resetUrl = `${clientOrigin}/reset-password/${token}`;

  await transporter.sendMail({
    from: `"AnimeGo" <${process.env.SMTP_USER}>`,
    to,
    subject: '【AnimeGo】重置你的密码',
    html: `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0f172a; color: #f1f5f9; border-radius: 16px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #7c3aed, #06b6d4); padding: 32px; text-align: center;">
          <h1 style="margin: 0; font-size: 28px; font-weight: 800; color: #fff; letter-spacing: -0.5px;">AnimeGo</h1>
          <p style="margin: 8px 0 0; color: rgba(255,255,255,0.85); font-size: 14px;">重置你的密码</p>
        </div>
        <div style="padding: 40px 32px;">
          <p style="margin: 0 0 16px; color: #cbd5e1; font-size: 15px; line-height: 1.6;">
            你收到这封邮件是因为有人请求重置你的 AnimeGo 账号密码。
          </p>
          <p style="margin: 0 0 32px; color: #cbd5e1; font-size: 15px; line-height: 1.6;">
            点击下方按钮设置新密码。链接将在 <strong style="color: #f1f5f9;">1 小时</strong>后失效。
          </p>
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${resetUrl}"
               style="display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #7c3aed, #6d28d9); color: #fff; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 15px; letter-spacing: 0.3px;">
              重置密码
            </a>
          </div>
          <p style="margin: 0 0 8px; color: #64748b; font-size: 12px; line-height: 1.6;">
            如果按钮无法点击，请复制以下链接到浏览器：
          </p>
          <p style="margin: 0 0 32px; word-break: break-all; color: #7c3aed; font-size: 12px;">${resetUrl}</p>
          <hr style="border: none; border-top: 1px solid rgba(148,163,184,0.1); margin-bottom: 24px;" />
          <p style="margin: 0; color: #475569; font-size: 12px; line-height: 1.6;">
            如果你没有请求重置密码，可以忽略这封邮件，你的账号不会有任何变化。
          </p>
        </div>
      </div>
    `,
  });
};
