import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

describe("join table timestamps", () => {
  it("stamps bot_inboxes, thread_subjects and thread_messages, and moves updated_at on update", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    await sendGithub(inbox, "pull_request", prPayload(1));
    const messages = (await call("GET", `/inboxes/${inbox.id}/messages?order=asc`, { key })).body.data as {
      id: string;
    }[];
    const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
    const assigned = await call("POST", `/bots/${bot.id}/assign`, {
      key,
      body: {
        lease_token: lease,
        cursor: 0,
        assignments: [{ message_id: messages[0]!.id, thread_id: randomUUID(), add_subjects: ["s/1"] }],
      },
    });
    expect(assigned.status).toBe(200);

    const [bi] = await db.query<{ created_at: Date | null }>(
      `SELECT created_at FROM loopway.bot_inboxes WHERE bot_id = $1`,
      [bot.id],
    );
    expect(bi!.created_at).toBeInstanceOf(Date);
    const [ts] = await db.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM loopway.thread_subjects WHERE bot_id = $1`,
      [bot.id],
    );
    expect(ts!.created_at).toBeInstanceOf(Date);

    await db.query(`UPDATE loopway.thread_messages SET updated_at = 'epoch' WHERE bot_id = $1`, [bot.id]);
    await db.query(`UPDATE loopway.thread_messages SET state = 'inflight' WHERE bot_id = $1`, [bot.id]);
    const [tm] = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM loopway.thread_messages WHERE bot_id = $1`,
      [bot.id],
    );
    expect(tm!.updated_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
