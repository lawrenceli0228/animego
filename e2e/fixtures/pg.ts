// Postgres fixture helpers — the sandbox suite's only database surface.
//
// Postgres is authoritative for everything these specs touch: go-api
// resolves credentials with sqlc-over-pgx (auth/handlers.go), and the
// Mongo the suite used to double-write to was retired from the stack at
// the P9 cutover. This module provides the helpers the suite needs to:
//   1. Wipe stragglers + seed the e2e-sandbox user (globalSetup).
//   2. Insert per-spec users (auth, admin specs).
//   3. Read the reset-password token (forgot-password spec).
//   4. Seed and read anime_cache / subscriptions (library-watch-sync).
//
// Connects to localhost:5432, which docker-compose.ci.yml publishes —
// the base compose file publishes no database port (prod-correct; these
// fixtures run on the host, outside the compose network). Override the
// whole connection string with POSTGRES_URL for other environments.
//
// Connection is lazy-singleton; callers should await closePg() in
// afterAll / after globalSetup to let Playwright exit cleanly.

import postgres from "postgres";
import { TEST_PASSWORD_HASH } from "./users";

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

// Bcrypt hash of `e2e-test-pass-123` (cost 10). Imported rather than
// re-declared: this file and fixtures/users.ts held byte-identical copies
// before, and a hash that silently drifts from the plaintext the specs
// type into the login form fails as "wrong password" with no hint why.
const SEED_PASSWORD_HASH = TEST_PASSWORD_HASH;

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

/**
 * Wipe every user whose email carries the `e2e-test-` prefix. Returns the
 * delete count so globalSetup can log it.
 *
 * Called ONCE from globalSetup, before any worker starts — per-spec
 * cleanup races the parallel workers (admin.spec's freshly-inserted
 * account would be deleted mid-login by auth.spec's teardown).
 *
 * The prefix is the whole safety mechanism, so it is matched on the
 * left-anchored form only: `fixtures/users.ts` mints every address as
 * `e2e-test-<uuid>@animego.test`, and the persistent sandbox seed user is
 * `e2e+sandbox@animegoclub.com`, which this deliberately does NOT match.
 * Every FK onto `users(id)` is ON DELETE CASCADE (migrations 0001, 0018,
 * 0019), so the row's subscriptions/comments/follows go with it.
 */
export async function cleanupTestUsersInPostgres(): Promise<number> {
  const sql = getSql();
  const rows = await sql`
    DELETE FROM users WHERE email LIKE 'e2e-test-%' RETURNING id
  `;
  return rows.count ?? 0;
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
  /**
   * AniList `format`. Load-bearing for the episode-offset walk, which sums
   * only TV ancestors — a chain whose members are seeded without it counts
   * nothing and reports an offset of 0 with full confidence.
   */
  format?: string | null;
}

/** Insert (or refresh) one `anime_cache` row. Idempotent. */
export async function ensureAnimeCached(anime: SeedAnimeCache): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, episodes, format, cached_at)
    VALUES (
      ${anime.anilistId},
      ${anime.titleRomaji ?? `E2E Anime ${anime.anilistId}`},
      ${anime.titleChinese ?? `E2E 番剧 ${anime.anilistId}`},
      ${anime.episodes ?? null},
      ${anime.format ?? "TV"},
      now()
    )
    ON CONFLICT (anilist_id) DO UPDATE SET
      title_romaji  = EXCLUDED.title_romaji,
      title_chinese = EXCLUDED.title_chinese,
      episodes      = EXCLUDED.episodes,
      format        = EXCLUDED.format,
      updated_at    = now()
  `;
}

/**
 * Point one anime at its prequel, the way the AniList detail sync does.
 *
 * `anime_relations.anime_id` carries the FK onto anime_cache; the target
 * `anilist_id` does not, which is what lets a season name a prequel this cache
 * has never fetched. Both rows must exist before calling this for the owner
 * side of that FK to hold.
 *
 * Not idempotent by conflict — the table has a uuid PK and admits the same
 * pair twice on purpose (one anime can be a SEQUEL and an ALTERNATIVE of the
 * same parent), so the delete comes first. Seeding it twice would otherwise
 * read as the ambiguity case and report the offset as unknown.
 */
export async function seedPrequelRelation(
  animeId: number,
  prequelAnilistId: number,
): Promise<void> {
  const sql = getSql();
  await sql`
    DELETE FROM anime_relations
    WHERE anime_id = ${animeId} AND relation_type = 'PREQUEL'
  `;
  await sql`
    INSERT INTO anime_relations (anime_id, anilist_id, relation_type)
    VALUES (${animeId}, ${prequelAnilistId}, 'PREQUEL')
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

export interface SeedAnimeDetail extends SeedAnimeCache {
  /**
   * The count migration 0023's sweep infers from an external episode source.
   * Held apart from `episodes` all the way to the wire on purpose — only the
   * authoritative one may reach JSON-LD — and the detail page's episode
   * section is `pending` only when BOTH are absent, so a spec about the
   * pending state has to pin this too rather than let a leftover row decide.
   */
  episodesBgm?: number | null;
  /** AniList status string, e.g. `"RELEASING"`. */
  status?: string | null;
}

/**
 * Seed one anime the DETAIL page can render without going to AniList.
 *
 * `ensureAnimeCached` alone is not enough for `/anime/{id}`. `isStale`
 * (go-api/internal/anime/detail.go) trips on an empty studio list, an empty
 * character list, or a first character with no role — independently of
 * `cached_at` — and a stale row makes the handler fetch AniList live. In CI
 * that is a real network call on every run; worse, a successful one OVERWRITES
 * the seeded row, so a spec asserting on `episodes IS NULL` would be asserting
 * against whatever AniList happens to say. One studio and one character with a
 * role are the cheapest way to make the row look complete and keep the read
 * entirely inside Postgres.
 *
 * The child rows are deleted first rather than upserted: they have surrogate
 * uuid keys, so a re-run would otherwise stack duplicates.
 */
export async function ensureAnimeDetail(anime: SeedAnimeDetail): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO anime_cache (
      anilist_id, title_romaji, title_chinese, episodes, episodes_bgm,
      status, cached_at
    )
    VALUES (
      ${anime.anilistId},
      ${anime.titleRomaji ?? `E2E Anime ${anime.anilistId}`},
      ${anime.titleChinese ?? `E2E 番剧 ${anime.anilistId}`},
      ${anime.episodes ?? null},
      ${anime.episodesBgm ?? null},
      ${anime.status ?? null},
      now()
    )
    ON CONFLICT (anilist_id) DO UPDATE SET
      title_romaji  = EXCLUDED.title_romaji,
      title_chinese = EXCLUDED.title_chinese,
      episodes      = EXCLUDED.episodes,
      episodes_bgm  = EXCLUDED.episodes_bgm,
      status        = EXCLUDED.status,
      cached_at     = now(),
      updated_at    = now()
  `;
  await sql`DELETE FROM anime_studios WHERE anime_id = ${anime.anilistId}`;
  await sql`DELETE FROM anime_characters WHERE anime_id = ${anime.anilistId}`;
  await sql`
    INSERT INTO anime_studios (anime_id, studio)
    VALUES (${anime.anilistId}, 'E2E Animation Works')
  `;
  await sql`
    INSERT INTO anime_characters (anime_id, display_order, name_en, role)
    VALUES (${anime.anilistId}, 0, 'E2E Protagonist', 'MAIN')
  `;

  // Verify the postcondition this function's whole name is a promise about.
  //
  // The failure it guards is silent and expensive: a row that exists but
  // reads as stale renders as a 404 when AniList is unreachable, and the
  // spec that trips over it reports "expected 200, received 404" — a
  // sentence with no fixture in it. Chasing that from the other end costs a
  // CI round trip per hypothesis. It is what happened when `locale-routing`
  // was "fixed" with `ensureAnimeCached`, whose row satisfies none of this.
  const [seeded] = await sql`
    SELECT (SELECT count(*) FROM anime_studios WHERE anime_id = ${anime.anilistId}) AS studios,
           (SELECT count(*) FROM anime_characters
             WHERE anime_id = ${anime.anilistId} AND role IS NOT NULL) AS characters
  `;
  if (Number(seeded?.studios ?? 0) === 0 || Number(seeded?.characters ?? 0) === 0) {
    throw new Error(
      `ensureAnimeDetail(${anime.anilistId}): seeded row is still stale ` +
        `(studios=${seeded?.studios}, characters-with-role=${seeded?.characters}). ` +
        `isStale trips on either being empty, so /anime/${anime.anilistId} would ` +
        `go to AniList and 404 whenever that call fails.`,
    );
  }
}

/**
 * Drop a seeded anime and everything hanging off it.
 *
 * Every child table in migration 0001 references `anime_cache(anilist_id)` with
 * ON DELETE CASCADE — studios, characters, episode titles, subscriptions — so
 * one delete is the whole teardown. Safe to call for an id that was never
 * seeded.
 */
export async function removeAnimeFixture(anilistId: number): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM anime_cache WHERE anilist_id = ${anilistId}`;
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
  // Seed the per-episode marks this progress implies (migration 0024).
  //
  // Not decoration. `current_episode` is a derived value now — every write path
  // recomputes it as COALESCE(MAX(episode), 0) over episode_watches — so a row
  // carrying progress with no marks behind it is a state no user can reach, and
  // the next PATCH re-derives it to 0. A spec that seeded 5 and then asserted on
  // progress would be asserting against a row the application could not produce,
  // and would start failing for a reason that has nothing to do with what it
  // tests. This mirrors what migration 0024's backfill does for real rows.
  if (currentEpisode > 0) {
    await sql`
      INSERT INTO episode_watches (user_id, anilist_id, episode)
      SELECT
        (SELECT id FROM users WHERE email = ${email.toLowerCase()}),
        ${anilistId},
        g.episode
      FROM generate_series(1, ${currentEpisode}) AS g(episode)
      ON CONFLICT (user_id, anilist_id, episode) DO NOTHING
    `;
  }
}
