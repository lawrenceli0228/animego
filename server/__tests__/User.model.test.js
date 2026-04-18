const bcrypt = require('bcrypt');
const User = require('../models/User');

function runPreSave(doc) {
  return new Promise((resolve, reject) => {
    doc.schema.s.hooks.execPre('save', doc, [], (err) => (err ? reject(err) : resolve()));
  });
}

describe('User model', () => {
  describe('schema validation', () => {
    it('requires username, email, and password', () => {
      const u = new User({});
      const err = u.validateSync();
      expect(err.errors.username).toBeDefined();
      expect(err.errors.email).toBeDefined();
      expect(err.errors.password).toBeDefined();
    });

    it('rejects username shorter than 3 chars', () => {
      const u = new User({ username: 'ab', email: 'a@b.co', password: 'x' });
      const err = u.validateSync();
      expect(err.errors.username).toBeDefined();
    });

    it('rejects username longer than 50 chars', () => {
      const u = new User({ username: 'a'.repeat(51), email: 'a@b.co', password: 'x' });
      const err = u.validateSync();
      expect(err.errors.username).toBeDefined();
    });

    it('lowercases and trims email', () => {
      const u = new User({ username: 'alice', email: '  Alice@Example.COM  ', password: 'x' });
      expect(u.email).toBe('alice@example.com');
    });

    it('trims username', () => {
      const u = new User({ username: '  alice  ', email: 'a@b.co', password: 'x' });
      expect(u.username).toBe('alice');
    });

    it('defaults role to null and accepts only "admin" or null', () => {
      const guest = new User({ username: 'alice', email: 'a@b.co', password: 'x' });
      expect(guest.role).toBeNull();

      const admin = new User({ username: 'alice', email: 'a@b.co', password: 'x', role: 'admin' });
      expect(admin.validateSync()).toBeUndefined();

      const invalid = new User({ username: 'alice', email: 'a@b.co', password: 'x', role: 'moderator' });
      expect(invalid.validateSync().errors.role).toBeDefined();
    });
  });

  describe('password hashing (pre-save hook)', () => {
    it('hashes the password before save when modified', async () => {
      const u = new User({ username: 'alice', email: 'a@b.co', password: 'secret123' });
      await runPreSave(u);
      expect(u.password).not.toBe('secret123');
      expect(await bcrypt.compare('secret123', u.password)).toBe(true);
    });

    it('skips hashing when password is not modified', async () => {
      const u = new User({ username: 'alice', email: 'a@b.co', password: 'already-hashed' });
      // Clear the modified-fields tracking so isModified('password') returns false
      u.unmarkModified('password');
      await runPreSave(u);
      expect(u.password).toBe('already-hashed');
    });

    it('produces different hashes for the same password (bcrypt salt)', async () => {
      const a = new User({ username: 'alice', email: 'a@b.co', password: 'same' });
      const b = new User({ username: 'bob', email: 'b@b.co', password: 'same' });
      await runPreSave(a);
      await runPreSave(b);
      expect(a.password).not.toBe(b.password);
    });
  });

  describe('comparePassword method', () => {
    it('returns true for a matching plaintext password', async () => {
      const u = new User({ username: 'alice', email: 'a@b.co', password: 'mypass' });
      await runPreSave(u);
      await expect(u.comparePassword('mypass')).resolves.toBe(true);
    });

    it('returns false for a non-matching plaintext password', async () => {
      const u = new User({ username: 'alice', email: 'a@b.co', password: 'mypass' });
      await runPreSave(u);
      await expect(u.comparePassword('wrong')).resolves.toBe(false);
    });
  });

  describe('toJSON method', () => {
    it('removes password and refreshToken from JSON output', () => {
      const u = new User({
        username: 'alice',
        email: 'a@b.co',
        password: 'hashed',
        refreshToken: 'refresh-secret',
      });
      const json = u.toJSON();
      expect(json.password).toBeUndefined();
      expect(json.refreshToken).toBeUndefined();
      expect(json.username).toBe('alice');
      expect(json.email).toBe('a@b.co');
    });

    it('preserves safe fields like role and resetPasswordToken', () => {
      // resetPasswordToken is not stripped by toJSON — documented expectation
      const u = new User({
        username: 'alice',
        email: 'a@b.co',
        password: 'hashed',
        role: 'admin',
        resetPasswordToken: 'reset-token',
      });
      const json = u.toJSON();
      expect(json.role).toBe('admin');
      expect(json.resetPasswordToken).toBe('reset-token');
    });
  });
});
