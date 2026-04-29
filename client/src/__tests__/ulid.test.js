import { describe, it, expect } from 'vitest';
import { ulid } from '../lib/library/ulid';

describe('ulid', () => {
  it('returns a 26-character string', () => {
    const id = ulid();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(26);
  });

  it('only uses Crockford base32 alphabet (no I L O U)', () => {
    const alphabet = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
    for (let i = 0; i < 20; i++) {
      expect(ulid()).toMatch(alphabet);
    }
  });

  it('is deterministic when seed is provided', () => {
    const a = ulid(12345);
    const b = ulid(12345);
    expect(a).toBe(b);
  });

  it('different seeds produce different values', () => {
    expect(ulid(1)).not.toBe(ulid(2));
  });

  it('produces monotonically non-decreasing ids without seed (time prefix)', () => {
    const ids = Array.from({ length: 10 }, () => ulid());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] >= ids[i - 1]).toBe(true);
    }
  });

  it('does not contain I, L, O, or U (Crockford omissions)', () => {
    for (let i = 0; i < 100; i++) {
      const id = ulid(i * 7919);
      expect(id).not.toMatch(/[ILOU]/);
    }
  });

  it('different calls without seed produce unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => ulid()));
    expect(ids.size).toBe(50);
  });
});
