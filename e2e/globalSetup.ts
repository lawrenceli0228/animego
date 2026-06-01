import { chromium, type FullConfig } from "@playwright/test";
import { MongoClient, ObjectId } from "mongodb";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanupAllTestUsers, closeMongo } from "./fixtures/mongo";
import { closePg, ensureSeedUserInPostgres } from "./fixtures/pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const MONGO_DB = process.env.MONGO_DB ?? "animego";
const BASE_URL =
  process.env.E2E_SANDBOX_BASE_URL ?? "https://localhost";
const STORAGE_STATE_PATH = path.join(__dirname, ".auth", "user.json");

export const SEED_USER_EMAIL = "e2e+sandbox@animegoclub.com";
export const SEED_USER_PASSWORD = "e2e-test-pass-123";
const SEED_USER_HASH =
  "$2b$10$0tYXiDYWWnzh8uXwMxNNquwlmvu1W65wOfaD5awi3cEuX.HlvBn8K";
const SEED_USER_USERNAME = "e2e-sandbox";

export const SEED_USER_ID = new ObjectId("e2e00000000000000000cafe");
export const SEED_SUB_IDS = [
  new ObjectId("e2e00000000000000000b001"),
  new ObjectId("e2e00000000000000000b002"),
  new ObjectId("e2e00000000000000000b003"),
];

async function seed(): Promise<void> {
  const client = new MongoClient(MONGO_URL, {
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });
  await client.connect();
  const db = client.db(MONGO_DB);

  const users = db.collection("users");
  const subscriptions = db.collection("subscriptions");

  await users.deleteOne({ _id: SEED_USER_ID });
  await subscriptions.deleteMany({ userId: SEED_USER_ID });

  const now = new Date();
  await users.insertOne({
    _id: SEED_USER_ID,
    username: SEED_USER_USERNAME,
    email: SEED_USER_EMAIL,
    password: SEED_USER_HASH,
    role: null,
    refreshToken: null,
    resetPasswordToken: null,
    resetPasswordExpires: null,
    createdAt: now,
    updatedAt: now,
  });

  await subscriptions.insertMany([
    {
      _id: SEED_SUB_IDS[0],
      userId: SEED_USER_ID,
      anilistId: 21,
      status: "watching",
      currentEpisode: 3,
      score: null,
      lastWatchedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: SEED_SUB_IDS[1],
      userId: SEED_USER_ID,
      anilistId: 11061,
      status: "completed",
      currentEpisode: 26,
      score: 9,
      lastWatchedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: SEED_SUB_IDS[2],
      userId: SEED_USER_ID,
      anilistId: 1535,
      status: "plan_to_watch",
      currentEpisode: 0,
      score: null,
      lastWatchedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await client.close();
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Sandbox-only setup: seed Mongo + Postgres, then browser-login to mint the
  // storageState the chromium-sandbox project reuses. The read-only
  // chromium-prod project (and any `playwright test --project=chromium-prod`,
  // e.g. .github/workflows/e2e.yml) needs none of it — and would trip over the
  // retired Mongo / an absent POSTGRES_PASSWORD. Opt IN via E2E_SANDBOX so
  // prod-style runs are a no-op by default.
  if (!process.env.E2E_SANDBOX) return;

  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  // Wipe stragglers from prior runs BEFORE seeding, so per-spec cleanup
  // can be dropped (it races with parallel workers).
  await cleanupAllTestUsers();
  await closeMongo();

  await seed();

  // P8.5: ensure the seed user also exists in Postgres so the browser
  // login goes through the Go API (which reads Postgres) and the
  // storageState carries a valid session cookie.
  await ensureSeedUserInPostgres(SEED_USER_USERNAME, SEED_USER_EMAIL);
  await closePg();

  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);
  await page.locator("#login-email").fill(SEED_USER_EMAIL);
  await page.locator("#login-password").fill(SEED_USER_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
