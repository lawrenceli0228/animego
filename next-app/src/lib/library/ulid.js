// @ts-check
// Pure function — no React, no IDB, no DOM.
// Crockford base32 alphabet (excludes I, L, O, U).

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32

/** Monotonic state for same-millisecond increments */
let _lastTime = 0;
let _lastRandom = new Uint16Array(4);

/**
 * Encode an integer `value` into `length` Crockford base32 chars (right-to-left fill).
 * @param {number} value
 * @param {number} length
 * @returns {string}
 */
function encodeBase32(value, length) {
  let str = '';
  let v = value;
  for (let i = 0; i < length; i++) {
    str = ENCODING[v % ENCODING_LEN] + str;
    v = Math.floor(v / ENCODING_LEN);
  }
  return str;
}

/**
 * Encode a timestamp in milliseconds as `length` Crockford base32 characters.
 * @param {number} timeMs
 * @param {number} length
 * @returns {string}
 */
function encodeTime(timeMs, length) {
  let str = '';
  let t = timeMs;
  for (let i = 0; i < length; i++) {
    str = ENCODING[t % ENCODING_LEN] + str;
    t = Math.floor(t / ENCODING_LEN);
  }
  return str;
}

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 * Format: 10 chars time + 16 chars random = 26 chars, Crockford base32.
 *
 * When called without a seed, the time component is monotonically non-decreasing:
 * same-millisecond calls increment the random suffix to preserve sort order.
 *
 * @param {number} [seed] - When provided, produces a deterministic output (test mode).
 *   Seed is used as a pseudo-random source; no wall-clock dependency.
 * @returns {string} 26-char Crockford-base32 ULID
 */
export function ulid(seed) {
  if (seed !== undefined) {
    // Deterministic mode: derive time and random parts from seed via LCG.
    let state = seed >>> 0;
    const next = () => {
      // LCG constants from Numerical Recipes
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state;
    };

    // 48-bit time value from seed
    const hi = next() & 0xffff;
    const lo = next();
    const timeMs = hi * 0x100000 + (lo % 0x100000);

    // 4 × 16-bit random words
    const r0 = next() & 0xffff;
    const r1 = next() & 0xffff;
    const r2 = next() & 0xffff;
    const r3 = next() & 0xffff;

    const timePart = encodeTime(timeMs, 10);
    const randPart =
      encodeBase32(r0, 4) +
      encodeBase32(r1, 4) +
      encodeBase32(r2, 4) +
      encodeBase32(r3, 4);

    return timePart + randPart;
  }

  // Non-deterministic monotonic mode
  let now = Date.now();

  const buf = new Uint16Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 0x10000);
  }

  if (now === _lastTime) {
    // Increment random suffix to guarantee monotonicity within the same millisecond
    // Treat _lastRandom as a big-endian 64-bit counter (4 × 16-bit words)
    let carry = 1;
    for (let i = 3; i >= 0 && carry; i--) {
      const sum = _lastRandom[i] + carry;
      _lastRandom[i] = sum & 0xffff;
      carry = sum >>> 16;
    }
    // Copy incremented random into buf
    buf[0] = _lastRandom[0];
    buf[1] = _lastRandom[1];
    buf[2] = _lastRandom[2];
    buf[3] = _lastRandom[3];
  } else if (now < _lastTime) {
    // Clock moved back — use last time to stay monotonic
    now = _lastTime;
    _lastRandom.set(buf);
  } else {
    _lastTime = now;
    _lastRandom.set(buf);
  }

  const timePart = encodeTime(now, 10);
  const randPart =
    encodeBase32(buf[0], 4) +
    encodeBase32(buf[1], 4) +
    encodeBase32(buf[2], 4) +
    encodeBase32(buf[3], 4);

  return timePart + randPart;
}
