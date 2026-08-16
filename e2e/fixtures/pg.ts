// P8.5 dress rehearsal — Postgres fixture helpers.
//
// When nginx routes /api/ to go-api, auth state lives in Postgres, not
// Mongo. This module provides the minimal helpers the e2e sandbox suite
// needs to:
//   1. Seed the e2e-sandbox user in Postgres (globalSetup).
//   2. Read the reset-password token from Postgres (forgot-password spec).
//
// DATABASE_URL defaults to the CI-overlay-exposed port (5432 mapped to
// localhost). Override with POSTGRES_URL env for other environments.
//
// Connection is lazy-singleton; callers should await closePg() in
// afterAll / after globalSetup to let Playwright exit cleanly.

import postgres from "postgres";

// POSTGRES_URL is the override; otherwise compose from POSTGRES_PASSWORD.
// We do NOT inline a fallback password — a real prod password as a
// "default" is a leak waiting to happen. CI passes POSTGRES_PASSWORD
// via docker-compose.ci.yml; local devs source .env.production before
// running.
function buildDatabaseUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const pw = process.env.POSTGRES_PASSWORD;
  if (!pw) {
    throw new Error(
      "e2e/fixtures/pg.ts: POSTGRES_PASSWORD (or POSTGRES_URL) must be set. " +
        "Source .env.production or set the var in your shell before running e2e.",
    );
  }
  return `postgres://animego:${pw}@localhost:5432/animego?sslmode=disable`;
}

let _sql: ReturnType<typeof postgres> | null = null;

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    // Lazy: resolve the connection string (and throw on a missing password)
    // only when a DB helper is actually called. Importing this module must
    // stay side-effect-free — globalSetup imports it unconditionally, and the
    // read-only chromium-prod project never touches Postgres.
    _sql = postgres(buildDatabaseUrl(), { max: 3, connect_timeout: 5 });
  }
  return _sql;
}

export async function closePg(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

// Pre-computed bcrypt hash of `e2e-test-pass-123` at cost factor 10.
// Must match TEST_PASSWORD_HASH in mongo.ts.
const SEED_PASSWORD_HASH =
  "$2b$10$0tYXiDYWWnzh8uXwMxNNquwlmvu1W65wOfaD5awi3cEuX.HlvBn8K";

/**
 * Ensure the static sandbox seed user exists in Postgres.
 * Called from globalSetup. Idempotent: does nothing if the user already
 * exists (ON CONFLICT DO NOTHING). This is safe to call on every test
 * run because the user's credentials never change.
 */
export async function ensureSeedUserInPostgres(
  username: string,
  email: string,
): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO users (username, email, password, is_public, created_at, updated_at)
    VALUES (${username}, ${email.toLowerCase()}, ${SEED_PASSWORD_HASH}, true, now(), now())
    ON CONFLICT (email) DO NOTHING
  `;
}

export interface ResetTokenRecord {
  token: string;
  expiresAt: Date;
}

/**
 * Read the most recent password-reset token for a given email from Postgres.
 * Returns null if no token has been issued or fields are null.
 * Used by the forgot-password e2e spec (Go API writes the token to Postgres).
 */
export async function getResetTokenFromPg(
  email: string,
): Promise<ResetTokenRecord | null> {
  const sql = getSql();
  const rows = await sql<
    { reset_password_token: string | null; reset_password_expires: Date | null }[]
  >`
    SELECT reset_password_token, reset_password_expires
    FROM users
    WHERE email = ${email.toLowerCase()}
    LIMIT 1
  `;
  if (
    rows.length === 0 ||
    !rows[0].reset_password_token ||
    !rows[0].reset_password_expires
  ) {
    return null;
  }
  return {
    token: rows[0].reset_password_token,
    expiresAt: rows[0].reset_password_expires,
  };
}

/**
 * Insert a test user directly into Postgres with the pre-hashed password.
 * The hash must match the plaintext the spec will use for login/forgot-password.
 * Idempotent: ON CONFLICT (email) DO NOTHING.
 */
export async function insertPgUser(user: {
  username: string;
  email: string;
  passwordHash: string;
  role?: "admin" | null;
}): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO users (username, email, password, role, is_public, created_at, updated_at)
    VALUES (
      ${user.username},
      ${user.email.toLowerCase()},
      ${user.passwordHash},
      ${user.role ?? null},
      true,
      now(),
      now()
    )
    ON CONFLICT (email) DO NOTHING
  `;
}

/**
 * Delete a test user from Postgres by email. Used for cleanup of per-spec
 * users created via the Go API register endpoint.
 */
export async function deletePgUserByEmail(email: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM users WHERE email = ${email.toLowerCase()}`;
}

// ─── watch-progress sync fixtures ───────────────────────────────────────────
//
// `subscriptions.anilist_id` is a foreign key onto `anime_cache`, and
// `POST /api/subscriptions` runs `anime.EnsureCached` first — which, on a cache
// miss, goes out to the real AniList GraphQL API (go-api/internal/anime/
// ensure_cached.go:78). Seeding the cache row up front is what keeps the
// sandbox off the network and the assertion deterministic: `EnsureCached`
// returns on the first probe and never fetches.

export interface SeedAnimeCache {
  anilistId: number;
  titleRomaji?: string;
  titleChinese?: string;
  /**
   * The authoritative total. Two things read it:
   *   - the server's `currentEpisode` upper bound (400 past it; NULL = airing,
   *     no bound at all — design doc decision 4);
   *   - the home page's `N/M` badge, which only renders the `/M` half when
   *     this is a positive number (`ContinueWatching.tsx` badgeText).
   */
  episodes?: number | null;
}

/** Insert (or refresh) one `anime_cache` row. Idempotent. */
export async function ensureAnimeCached(anime: SeedAnimeCache): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, episodes, cached_at)
    VALUES (
      ${anime.anilistId},
      ${anime.titleRomaji ?? `E2E Anime ${anime.anilistId}`},
      ${anime.titleChinese ?? `E2E 番剧 ${anime.anilistId}`},
      ${anime.episodes ?? null},
      now()
    )
    ON CONFLICT (anilist_id) DO UPDATE SET
      title_romaji  = EXCLUDED.title_romaji,
      title_chinese = EXCLUDED.title_chinese,
      episodes      = EXCLUDED.episodes,
      updated_at    = now()
  `;
}

/**
 * Drop a user's subscriptions for the given titles.
 *
 * Per-spec rather than global on purpose: the sandbox project runs
 * `fullyParallel` on a single shared seed user, so isolation comes from every
 * spec owning its own AniList ids, not from wiping the table.
 */
export async function resetSubscriptions(
  email: string,
  anilistIds: readonly number[],
): Promise<void> {
  if (anilistIds.length === 0) return;
  const sql = getSql();
  await sql`
    DELETE FROM subscriptions
    WHERE user_id = (SELECT id FROM users WHERE email = ${email.toLowerCase()})
      AND anilist_id IN ${sql([...anilistIds])}
  `;
}

export interface SubscriptionRow {
  status: string;
  currentEpisode: number;
  lastWatchedAt: Date | null;
}

/** Read one subscription straight from Postgres, or null when absent. */
export async function readSubscription(
  email: string,
  anilistId: number,
): Promise<SubscriptionRow | null> {
  const sql = getSql();
  const rows = await sql<
    { status: string; current_episode: number; last_watched_at: Date | null }[]
  >`
    SELECT status, current_episode, last_watched_at
    FROM subscriptions
    WHERE user_id = (SELECT id FROM users WHERE email = ${email.toLowerCase()})
      AND anilist_id = ${anilistId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    currentEpisode: Number(row.current_episode),
    lastWatchedAt: row.last_watched_at,
  };
}

/**
 * Put a subscription into a known state directly.
 *
 * Used for the `dropped` precondition: the point of decision 3 is that a status
 * the user set by hand survives an automated "start tracking", and going
 * through the API to arrange that would exercise the very upsert branch under
 * test.
 */
export async function seedSubscription(
  email: string,
  anilistId: number,
  status: string,
  currentEpisode = 0,
): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO subscriptions (user_id, anilist_id, status, current_episode)
    VALUES (
      (SELECT id FROM users WHERE email = ${email.toLowerCase()}),
      ${anilistId},
      ${status},
      ${currentEpisode}
    )
    ON CONFLICT (user_id, anilist_id) DO UPDATE SET
      status          = EXCLUDED.status,
      current_episode = EXCLUDED.current_episode
  `;
}
