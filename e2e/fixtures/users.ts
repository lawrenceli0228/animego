// P10 sandbox — TestUser factory.
//
// Builds a unique-per-call TestUser with the canned bcrypt hash so
// Mongo-inserted users can be logged in with the matching plaintext
// password. Email and username are randomized with the `e2e-test-`
// prefix so `cleanupAllTestUsers` matches them on the regex sweep.

import { randomUUID } from "node:crypto";
import {
  TEST_PASSWORD,
  TEST_PASSWORD_HASH,
  type TestUser,
} from "./mongo";

/**
 * Generate a fresh TestUser. Email uses a `.test` TLD so we never
 * collide with a real user account and the spec-author can grep it
 * out of Mongo logs easily. Username is derived from the UUID prefix
 * — keep it under the 50-char schema cap (uuid is 36 chars + prefix
 * keeps us at ~45, well under).
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

export { TEST_PASSWORD, TEST_PASSWORD_HASH };
export type { TestUser };
