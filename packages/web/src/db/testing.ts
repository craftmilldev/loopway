import { randomBytes, randomUUID } from "node:crypto";
import {
  createBot,
  createInbox,
  createUser,
  insertMessage,
  setUsername,
  upsertRunner,
  writeAssignments,
} from "../store.js";
import { botActor } from "../actor.js";
import { migrate, openDb, type Db } from "./index.js";

/** The docker-compose.yml Postgres; CI sets TEST_DATABASE_URL to its service container. */
const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/postgres";

/** Test databases older than this were left by a run that died before drop(); nothing still uses them. */
const STALE_TEST_DATABASE_AGE = "1 hour";

let swept: Promise<void> | undefined;

/**
 * Drops the test databases older than STALE_TEST_DATABASE_AGE, once per process. Postgres doesn't keep a
 * database's creation time, but PG_VERSION is written when it's created and never again. Best effort:
 * another run may be sweeping too, and a server where we can't read files just keeps its leftovers.
 */
function sweepStaleTestDatabases(adminDb: Db): Promise<void> {
  swept ??= (async () => {
    try {
      const stale = await adminDb.query<{ datname: string }>(
        `SELECT datname FROM pg_database
         WHERE datname ~ '^loopway_test_[0-9a-f]+$'
           AND (pg_stat_file('base/' || oid || '/PG_VERSION')).modification < now() - $1::interval`,
        [STALE_TEST_DATABASE_AGE],
      );
      for (const { datname } of stale) {
        await adminDb.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch(() => {});
      }
    } catch {
      // Not allowed to read PG_VERSION, or a database vanished mid-query: leave the leftovers.
    }
  })();
  return swept;
}

/**
 * An empty throwaway database on the test Postgres server: its URL, and drop() to remove it.
 * For tests that need to connect by URL themselves; most want openTestDb().
 */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const admin = new URL(process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);
  const name = `loopway_test_${randomBytes(6).toString("hex")}`;
  const adminDb = await openDb({ databaseUrl: admin.toString() });
  try {
    await sweepStaleTestDatabases(adminDb);
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
  const message = await insertMessage(
    db,
    inbox.id,
    {
      specversion: "1.0",
      id: "fixture-1",
      source: "https://github.com/craftmill/loopway",
      type: "com.github.pull_request.opened",
      subject: "pull/1",
      time: "2026-10-01T12:00:00Z",
      data: { number: 1 },
    },
    false,
  );
  const threadId = randomUUID();
  await db.transaction((tx) =>
    writeAssignments(tx, bot.id, orgId, botActor(bot.id), [
      { message_id: message.id, thread_id: threadId, subject: "pull/1", author_kind: "human" },
    ]),
  );
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
