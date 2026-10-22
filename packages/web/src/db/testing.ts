import { randomBytes, randomUUID } from "node:crypto";
import {
  assignMessages,
  createBot,
  createInbox,
  createUser,
  insertMessage,
  leaseBot,
  setUsername,
  upsertRunner,
} from "../store.js";
import { migrate, openDb, type Db } from "./index.js";

/** The docker-compose.yml Postgres; CI sets TEST_DATABASE_URL to its service container. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/postgres";

/**
 * An empty throwaway database on the test Postgres server: its URL, and drop() to remove it.
 * For tests that need to connect by URL themselves; most want openTestDb().
 */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const admin = new URL(process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);
  const name = `loopway_test_${randomBytes(6).toString("hex")}`;
  const adminDb = await openDb({ databaseUrl: admin.toString() });
  try {
    await adminDb.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    await adminDb.close();
    throw new Error(`Can't reach the test Postgres at ${admin.host}. Start it with \`npm run db:up\`.`, { cause: err });
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      await adminDb.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await adminDb.close();
    },
  };
}

/**
 * A migrated Db in its own throwaway database on the test Postgres server, so test files stay
 * isolated and can run in parallel. close() drops the database.
 */
export async function openTestDb(): Promise<Db> {
  const testDatabase = await createTestDatabase();
  const db = await openDb({ databaseUrl: testDatabase.url });
  await migrate(db);
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(fn),
    async close() {
      await db.close();
      await testDatabase.drop();
    },
  };
}

/**
 * The same small world in every test database: a user with a personal org, an inbox with one message, a bot reading it
 * with a thread holding that message, and a runner. Written through the store, so it is what the app itself would
 * write on the schema the migrations built. It goes away with the database, so there is nothing to tear down.
 */
export async function seedFixtures(db: Db) {
  const { user } = await createUser(db, { name: "Fixture", email: "fixture@example.com" });
  const username = await setUsername(db, user.id, "fixture");
  if ("problem" in username) throw new Error(`Fixture username rejected: ${username.problem}`);
  const [org] = await db.query<{ id: string }>(`SELECT id FROM loopway.orgs WHERE personal_user_id = $1`, [user.id]);
  const orgId = org!.id;
  const inbox = await createInbox(db, {
    userId: user.id,
    orgId,
    name: "fixture-inbox",
    sourceType: "github",
    config: {},
  });
  const bot = await createBot(db, {
    userId: user.id,
    orgId,
    name: "fixture-bot",
    model: "sonnet",
    harness: "claude",
    inboxIds: [inbox.id],
    prompt: "Fixture prompt",
  });
  const runner = await upsertRunner(db, user.id, orgId, randomUUID(), "fixture-runner");
  const message = await insertMessage(db, inbox.id, {
    specversion: "1.0",
    id: "fixture-1",
    source: "https://github.com/craftmill/loopway",
    type: "com.github.pull_request.opened",
    subject: "pull/1",
    time: "2026-10-01T12:00:00Z",
    data: { number: 1 },
  });
  const lease = (await leaseBot(db, bot.id, 60, null, runner!.id))!;
  const threadId = randomUUID();
  await assignMessages(db, bot.id, lease.lock_token!, 0, [
    { message_id: message.id, thread_id: threadId, subject: "pull/1", author_kind: "human" },
  ]);
  return {
    userId: user.id,
    orgId,
    inboxId: inbox.id,
    botId: bot.id,
    runnerId: runner!.id,
    messageId: message.id,
    threadId,
  };
}

/** An `INBOX_SECRET_KEY` for tests that create inboxes. */
export const TEST_INBOX_KEY = Buffer.alloc(32, "test").toString("base64");
