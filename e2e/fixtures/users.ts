// Sandbox — TestUser factory and the canned credential pair.
//
// Builds a unique-per-call TestUser so a directly-inserted row can be
// logged in through the real form with the matching plaintext password.
// Email and username carry the `e2e-test-` prefix so
// `cleanupTestUsersInPostgres` can match them on a prefix sweep.
//
// This module used to re-export the password constants from
// `fixtures/mongo.ts`. Mongo was retired from the stack at the P9
// cutover — go-api reads Postgres and nothing else — so the fixture and
// its `mongodb` dependency are gone and the constants live here, next to
// the factory that is their only consumer.

import { randomUUID } from "node:crypto";

export interface TestUser {
  /** Stored lowercase; go-api lowercases before lookup (handlers.go:324). */
  email: string;
  username: string;
  /** Plaintext password for login attempts. */
  password: string;
  /** Bcrypt hash for direct DB insert (cost 10). */
  passwordHash: string;
  /** 'admin' for the privileged role, 'user' for regular accounts. */
  role: "user" | "admin";
}

// Pre-computed bcrypt hash of `e2e-test-pass-123` at cost factor 10.
// Generated locally via:
//   node -e "require('bcrypt').hash('e2e-test-pass-123', 10).then(console.log)"
// Verified against bcrypt.compare() before commit. Cost 10 is what
// go-api's jwtx.HashPassword uses, so the hash is comparable by
// jwtx.ComparePassword at login (auth/handlers.go:336).
//
// Inlined as a constant so the e2e package needs no bcrypt dependency.
export const TEST_PASSWORD = "e2e-test-pass-123";
export const TEST_PASSWORD_HASH =
  "$2b$10$0tYXiDYWWnzh8uXwMxNNquwlmvu1W65wOfaD5awi3cEuX.HlvBn8K";

/**
 * Generate a fresh TestUser. Email uses a `.test` TLD (RFC 2606, never
 * resolvable) so we can never collide with a real account and a stray
 * password-reset send can never leave the machine. Username is derived
 * from the UUID prefix — keep it under the 50-char cap the register
 * validator enforces (`e2e-test-` + 8 chars is well under).
 */
export function makeUser(role: TestUser["role"] = "user"): TestUser {
  const id = randomUUID();
  return {
    email: `e2e-test-${id}@animego.test`,
    username: `e2e-test-${id.slice(0, 8)}`,
    password: TEST_PASSWORD,
    passwordHash: TEST_PASSWORD_HASH,
    role,
  };
}
