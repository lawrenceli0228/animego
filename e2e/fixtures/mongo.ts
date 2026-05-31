// P10 sandbox — Mongo fixture helper.
//
// E2E v2 specs need to seed and reset users without going through the
// Express /api/auth/register surface (we want to insert pre-shaped
// admin accounts, bypass rate limits, and clean up between runs).
//
// Direct mongodb-driver writes against the same `users` collection
// Mongoose owns server-side. Schema notes (see server/models/User.js):
//   - field name is `password` (bcrypt-hashed, cost factor 10)
//   - field name is `role`     (enum: 'admin' | null; null for regular)
//   - `username` is required and unique with `email`
//   - `createdAt` / `updatedAt` are minted by mongoose's timestamps:true
//     option — we mint them ourselves on direct insert so admin pages
//     that sort by them don't choke on missing values.
//
// Every test email is prefixed `e2e-test-` so `cleanupAllTestUsers`
// can wipe stragglers with a regex sweep without risk of nuking real
// accounts. The CI workflow runs Mongo on `mongodb://localhost:27017`
// (docker-compose.ci.yml exposes the 27017 port); MONGO_URL overrides
// for local dev.

import { MongoClient, type Db, type Collection, type ObjectId } from "mongodb";

// Pre-computed bcrypt hash of `e2e-test-pass-123` at cost factor 10.
// Generated locally via:
//   node -e "require('bcrypt').hash('e2e-test-pass-123', 10).then(console.log)"
// Verified against bcrypt.compare() before commit. Cost factor 10
// matches `bcrypt.hash(this.password, 10)` in server/models/User.js.
//
// Inlined as a constant so the e2e package doesn't need bcrypt as a
// runtime dep (the v2 mongodb driver is the only extra dep we want).
export const TEST_PASSWORD = "e2e-test-pass-123";
export const TEST_PASSWORD_HASH =
  "$2b$10$0tYXiDYWWnzh8uXwMxNNquwlmvu1W65wOfaD5awi3cEuX.HlvBn8K";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const MONGO_DB = process.env.MONGO_DB ?? "animego";
const USERS_COLLECTION = "users";
const TEST_EMAIL_PREFIX = "e2e-test-";
const TEST_EMAIL_REGEX = /^e2e-test-/;

export interface TestUser {
  /** Mongoose lowercases emails on save — keep test emails lowercase. */
  email: string;
  username: string;
  /** Plaintext password for login attempts. */
  password: string;
  /** Bcrypt hash for direct DB insert (cost 10). */
  passwordHash: string;
  /** 'admin' for the privileged role, 'user' for regular accounts. */
  role: "user" | "admin";
}

interface UserDocument {
  username: string;
  email: string;
  password: string;
  role: "admin" | null;
  refreshToken: string | null;
  resetPasswordToken: string | null;
  resetPasswordExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ResetTokenRecord {
  token: string;
  expiresAt: Date;
}

let cachedClient: MongoClient | null = null;

async function getClient(): Promise<MongoClient> {
  if (cachedClient) return cachedClient;
  const client = new MongoClient(MONGO_URL, {
    // Tight timeouts so a misconfigured CI env fails fast instead of
    // burning the Playwright per-test 60s budget waiting for a TCP
    // connect that's never going to land.
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });
  await client.connect();
  cachedClient = client;
  return client;
}

async function getUsers(): Promise<Collection<UserDocument>> {
  const client = await getClient();
  const db: Db = client.db(MONGO_DB);
  return db.collection<UserDocument>(USERS_COLLECTION);
}

function dbRoleFor(role: TestUser["role"]): "admin" | null {
  // server-side enum is ['admin', null] — 'user' maps to null on disk.
  return role === "admin" ? "admin" : null;
}

/**
 * Insert a test user with bcrypt-hashed password. Returns the stringified
 * `_id`. Fails loudly on collision so we don't silently overwrite a real
 * account.
 */
export async function insertUser(user: TestUser): Promise<string> {
  if (!user.email.startsWith(TEST_EMAIL_PREFIX)) {
    throw new Error(
      `insertUser refused: email "${user.email}" missing the "${TEST_EMAIL_PREFIX}" prefix. ` +
        `Cleanup safety requires every fixture email to be matchable by the prefix regex.`,
    );
  }
  const users = await getUsers();
  const now = new Date();
  const doc: UserDocument = {
    username: user.username,
    email: user.email.toLowerCase(),
    password: user.passwordHash,
    role: dbRoleFor(user.role),
    refreshToken: null,
    resetPasswordToken: null,
    resetPasswordExpires: null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await users.insertOne(doc);
  return result.insertedId.toString();
}

/**
 * Convenience helper for admin journeys: builds an admin TestUser using
 * the canned hash, inserts it, returns both the record and the `_id`.
 */
export async function insertAdmin(email: string): Promise<{
  user: TestUser;
  id: string;
}> {
  const user: TestUser = {
    email,
    username: email.replace("@", "-at-").slice(0, 40),
    password: TEST_PASSWORD,
    passwordHash: TEST_PASSWORD_HASH,
    role: "admin",
  };
  const id = await insertUser(user);
  return { user, id };
}

/**
 * Delete a single test user by email (case-insensitive on the lowercase
 * stored value). Used by per-test teardown when a spec wants to verify a
 * user no longer exists.
 */
export async function deleteUserByEmail(email: string): Promise<void> {
  const users = await getUsers();
  await users.deleteOne({ email: email.toLowerCase() });
}

/**
 * Read the most recent password reset token for a given email. Returns
 * `null` if no token has been issued or it has expired.
 *
 * Used by the forgot-password journey: after POST /forgot-password we
 * read the token directly out of the user document because the only
 * production delivery channel is email (sendPasswordResetEmail) and
 * the sandbox stack does not send real mail.
 */
export async function getResetTokenForEmail(
  email: string,
): Promise<ResetTokenRecord | null> {
  const users = await getUsers();
  const doc = await users.findOne(
    { email: email.toLowerCase() },
    {
      projection: { resetPasswordToken: 1, resetPasswordExpires: 1 },
    },
  );
  if (!doc || !doc.resetPasswordToken || !doc.resetPasswordExpires) {
    return null;
  }
  return { token: doc.resetPasswordToken, expiresAt: doc.resetPasswordExpires };
}

/**
 * Wipe every user whose email starts with the e2e prefix. Returns the
 * delete count so callers can log noisy cleanup events in CI.
 */
export async function cleanupAllTestUsers(): Promise<number> {
  const users = await getUsers();
  const result = await users.deleteMany({ email: { $regex: TEST_EMAIL_REGEX } });
  return result.deletedCount ?? 0;
}

/**
 * Close the cached Mongo connection. Call from `afterAll` so Playwright
 * exits cleanly instead of waiting on an open socket.
 */
export async function closeMongo(): Promise<void> {
  if (!cachedClient) return;
  await cachedClient.close();
  cachedClient = null;
}

// Re-export ObjectId in case a spec wants to assert directly on the
// inserted document id.
export type { ObjectId };
