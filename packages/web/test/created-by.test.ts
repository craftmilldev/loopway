import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { botActor, formatActor, parseActor, runnerActor, userActor } from "../src/actor.js";
import { migrate } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { createLoginCode } from "../src/store.js";
import { call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";
import { migrateBefore } from "./migrate-before.js";

describe("actor", () => {
  it("formats and parses", () => {
    const id = randomUUID();
    expect(userActor(id)).toBe(`user:${id}`);
    expect(botActor(id)).toBe(`bot:${id}`);
    expect(runnerActor("r1")).toBe("runner:r1");
    expect(parseActor(formatActor("bot", id))).toEqual({ kind: "bot", id });
  });

  it("rejects what isn't an actor", () => {
    for (const v of ["", "user", "user:", ":x", "org:x"]) expect(parseActor(v), v).toBeUndefined();
  });
});

describe("created_by through the API", () => {
  it("is the caller for inboxes, bots and runners and the bot for threads", async () => {
    const key = await newUser();
    const me = `user:${(await call("GET", "/me", { key })).body.id}`;
    const inbox = await newInbox(key);
    expect((await call("GET", `/inboxes/${inbox.id}`, { key })).body.created_by).toBe(me);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    expect(bot.created_by).toBe(me);
    const runner = (await call("POST", "/runners", { key, body: { id: randomUUID(), name: "r" } })).body;
    expect(runner.created_by).toBe(me);

    await sendGithub(inbox, "pull_request", prPayload(1));
    const messages = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data;
    const assignAs = async (runnerId: string | undefined) => {
      const lease = (
        await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60, runner_id: runnerId } })
      ).body.lease.token;
      const id = randomUUID();
      await call("POST", `/bots/${bot.id}/assign`, {
        key,
        body: { lease_token: lease, cursor: 0, assignments: [{ message_id: messages[0].id, thread_id: id }] },
      });
      await call("POST", `/bots/${bot.id}/release`, { key, body: { lease_token: lease } });
      return id;
    };
    const threadId = await assignAs(undefined);
    expect((await call("GET", `/bots/${bot.id}/threads/${threadId}`, { key })).body.created_by).toBe(`bot:${bot.id}`);
    const byRunner = await assignAs(runner.id);
    expect((await call("GET", `/bots/${bot.id}/threads/${byRunner}`, { key })).body.created_by).toBe(
      `runner:${runner.id}`,
    );

    // The org-scoped events feed still lists the thread's creation.
    const events = (await call("GET", "/events", { key })).body.data;
    expect(events.map((e: { kind: string; thread_id: string }) => [e.kind, e.thread_id])).toContainEqual([
      "created",
      threadId,
    ]);
  });
});

describe("migration 022_created_by", () => {
  it("backfills created_by and org_id, and drops user_id everywhere but org_members", async () => {
    const fresh = await openTestDb();
    try {
      await migrateBefore(fresh, "022_created_by");
      const user = randomUUID();
      const org = randomUUID();
      const x = {
        inbox: randomUUID(),
        bot: randomUUID(),
        thread: randomUUID(),
        claimed: randomUUID(),
        runner: randomUUID(),
      };
      await fresh.query(`INSERT INTO loopway.users (id, name, email) VALUES ($1, 'u', 'u@example.com')`, [user]);
      await fresh.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, 'created-org', 'created-org')`, [org]);
      await fresh.query(
        `INSERT INTO loopway.inboxes (id, user_id, org_id, name, source_type) VALUES ($1, $2, $3, 'i', 'github')`,
        [x.inbox, user, org],
      );
      await fresh.query(
        `INSERT INTO loopway.bots (id, user_id, org_id, name, model) VALUES ($1, $2, $3, 'b', 'sonnet')`,
        [x.bot, user, org],
      );
      await fresh.query(`INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id, org_id) VALUES ($1, $2, $3, $4)`, [
        x.bot,
        x.inbox,
        user,
        org,
      ]);
      await fresh.query(`INSERT INTO loopway.threads (id, bot_id, user_id, org_id) VALUES ($1, $2, $3, $4)`, [
        x.thread,
        x.bot,
        user,
        org,
      ]);
      await fresh.query(
        `INSERT INTO loopway.thread_events (user_id, bot_id, thread_id, kind) VALUES ($1, $2, $3, 'created')`,
        [user, x.bot, x.thread],
      );
      await fresh.query(`INSERT INTO loopway.runners (id, user_id, org_id, name) VALUES ($1, $2, $3, 'r')`, [
        x.runner,
        user,
        org,
      ]);

      await fresh.query(
        `INSERT INTO loopway.threads (id, bot_id, user_id, org_id, runner_id) VALUES ($1, $2, $3, $4, $5)`,
        [x.claimed, x.bot, user, org, x.runner],
      );

      expect(await migrate(fresh)).toEqual([
        "022_created_by",
        "023_thread_events_org",
        "024_drop_user_id",
        "025_member_created_by",
        "026_bot_harness",
        "027_automation_level",
        "028_query_indexes",
        "029_hidden",
        "030_setup_bots",
      ]);

      const by = async (table: string, id: string) =>
        (await fresh.query<{ created_by: string }>(`SELECT created_by FROM loopway.${table} WHERE id = $1`, [id]))[0]!
          .created_by;
      expect(await by("inboxes", x.inbox)).toBe(`user:${user}`);
      expect(await by("bots", x.bot)).toBe(`user:${user}`);
      expect(await by("runners", x.runner)).toBe(`user:${user}`);
      expect(await by("threads", x.thread)).toBe(`bot:${x.bot}`);
      expect(await by("threads", x.claimed)).toBe(`runner:${x.runner}`);
      expect(await by("threads", x.claimed)).toBe(`runner:${x.runner}`);
      const events = await fresh.query<{ org_id: string }>(`SELECT org_id FROM loopway.thread_events`);
      expect(events.map((e) => e.org_id)).toEqual([org]);

      const withUserId = await fresh.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'loopway' AND column_name = 'user_id' ORDER BY table_name`,
      );
      expect(withUserId.map((r) => r.table_name)).toEqual(["org_members"]);

      // No foreign key on created_by.
      const fks = await fresh.query(
        `SELECT 1 FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints c ON c.constraint_name = k.constraint_name AND c.constraint_schema = k.constraint_schema
         WHERE k.table_schema = 'loopway' AND k.column_name = 'created_by' AND c.constraint_type = 'FOREIGN KEY'`,
      );
      expect(fks).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});

describe("created_by of org members and invites", () => {
  const who = async (key: string) => `user:${(await call("GET", "/me", { key })).body.id}`;
  const createdBy = async (table: string, where: string, orgId: string) =>
    (
      await db.query<{ created_by: string }>(`SELECT created_by FROM loopway.${table} WHERE org_id = $1 AND ${where}`, [
        orgId,
      ])
    )[0]?.created_by;

  it("is the adder, and an invite's adder carries over when the invitee joins", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const slug = `cb-${randomUUID().slice(0, 8)}`;
    expect((await call("POST", "/orgs", { key: a, body: { slug } })).status).toBe(201);
    const [org] = await db.query<{ id: string }>(`SELECT id FROM loopway.orgs WHERE slug = $1`, [slug]);
    const me = await who(a);
    // The creator added themselves.
    expect(await createdBy("org_members", `user_id = '${me.slice(5)}'`, org!.id)).toBe(me);

    // A member adds an existing user, and an email with no account yet.
    const bMe = (await call("GET", "/me", { key: b })).body;
    await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: bMe.email } });
    await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "later@example.com" } });
    expect(await createdBy("org_members", `user_id = '${bMe.id}'`, org!.id)).toBe(me);
    expect(await createdBy("org_invites", `true`, org!.id)).toBe(me);

    // The invitee signs up: their membership is credited to whoever invited them.
    const { code } = await createLoginCode(db, "later@example.com");
    const signup = await call("POST", "/auth/verify", {
      body: { email: "later@example.com", code, username: `later-${randomUUID().slice(0, 8)}` },
    });
    expect(signup.status).toBe(201);
    expect(await createdBy("org_members", `user_id = '${signup.body.user.id}'`, org!.id)).toBe(me);
  });
});
