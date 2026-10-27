import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { routeBot } from "../src/store.js";
import { call, db, events, newInbox, newUser, prPayload, sendGithub, settled } from "./helpers.js";

// A message about PR n goes to the thread holding "pr-n", or a new one.
const RULES = [{ types: ["*"], subject: "'pr-' + string(data.number)", action: "'attach'" }];

async function setup(rules: unknown = RULES) {
  const key = await newUser();
  const inbox = await newInbox(key);
  const bot = (
    await call("POST", "/bots", {
      key,
      body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id], prompt: "p", rules },
    })
  ).body;
  const threads = async (status = "all") =>
    (await call("GET", `/bots/${bot.id}/threads?status=${status}`, { key })).body.data as {
      id: string;
      subjects: string[];
      waiting: { id: string }[];
      runner_id: string | null;
    }[];
  return { key, inbox, bot, threads };
}

describe("server routing", () => {
  it("assigns a stored message to a new thread, then to the thread holding its subject", async () => {
    const { inbox, bot, threads } = await setup();
    expect((await sendGithub(inbox, "pull_request", prPayload(1))).status).toBeLessThan(300);
    await settled();
    const first = await threads();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ subjects: ["pr-1"], runner_id: null });
    expect(first[0]!.waiting).toHaveLength(1);

    await sendGithub(inbox, "pull_request", { ...prPayload(1), action: "closed" });
    await sendGithub(inbox, "pull_request", prPayload(2));
    await settled();
    const all = await threads();
    expect(all.map((t) => t.subjects).sort()).toEqual([["pr-1"], ["pr-2"]]);
    expect(all.find((t) => t.subjects[0] === "pr-1")!.waiting).toHaveLength(2);

    const b = (await db.query<{ cursor: string }>(`SELECT cursor FROM loopway.bots WHERE id = $1`, [bot.id]))[0]!;
    const last = (await db.query<{ seq: string }>(`SELECT max(seq) AS seq FROM loopway.messages`))[0]!;
    expect(Number(b.cursor)).toBe(Number(last.seq));
    expect(events.some((e) => e.event === "messages_routed" && e.properties?.assigned === 1)).toBe(true);
  });

  it("routes nothing for a bot with no rules and leaves its cursor", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    await sendGithub(inbox, "pull_request", prPayload(1));
    await settled();
    expect((await call("GET", `/bots/${bot.id}/threads?status=all`, { key })).body.data).toEqual([]);
    expect((await call("GET", `/bots/${bot.id}/messages`, { key })).body.data).toHaveLength(0);
  });

  it("still answers, and routes later, when routing fails", async () => {
    const { key, inbox, bot } = await setup();
    await db.query(`ALTER TABLE loopway.thread_subjects RENAME TO thread_subjects_away`);
    let res;
    try {
      res = await sendGithub(inbox, "pull_request", prPayload(1));
      await settled();
    } finally {
      await db.query(`ALTER TABLE loopway.thread_subjects_away RENAME TO thread_subjects`);
    }
    expect(res.status).toBeLessThan(300);
    expect(events.some((e) => e.event === "message_routing_failed")).toBe(true);
    expect(await db.query(`SELECT 1 FROM loopway.threads WHERE bot_id = $1`, [bot.id])).toEqual([]);
    // The message is stored and still past the cursor; the next request that touches the bot routes it.
    await new Promise((r) => setTimeout(r, 1100));
    await call("GET", `/bots/${bot.id}/messages`, { key });
    expect(await db.query(`SELECT 1 FROM loopway.threads WHERE bot_id = $1`, [bot.id])).toHaveLength(1);
  });

  it("routes two concurrent messages in order, with one thread per subject", async () => {
    const { inbox, bot, threads } = await setup();
    await Promise.all([
      sendGithub(inbox, "pull_request", prPayload(7)),
      sendGithub(inbox, "pull_request", { ...prPayload(7), action: "edited" }),
      sendGithub(inbox, "pull_request", { ...prPayload(7), action: "closed" }),
    ]);
    await settled();
    await Promise.all([routeBot(db, bot.id), routeBot(db, bot.id)]);
    const all = await threads();
    expect(all).toHaveLength(1);
    expect(all[0]!.waiting).toHaveLength(3);
  });

  it("skips a message whose rule throws, without blocking the ones after it", async () => {
    const { key, inbox, bot, threads } = await setup([
      { types: ["*"], subject: "string(data.number)", action: "data.action == 'edited' ? 'oops' : 'attach'" },
    ]);
    await sendGithub(inbox, "pull_request", { ...prPayload(1), action: "edited" });
    await sendGithub(inbox, "pull_request", prPayload(2));
    await settled();
    await new Promise((r) => setTimeout(r, 1100));
    await call("GET", `/bots/${bot.id}/messages`, { key });
    const all = await threads();
    expect(all.map((t) => t.subjects)).toEqual([["2"]]);
    expect(events.some((e) => e.event === "messages_routed" && e.properties?.rule_errors === 1)).toBe(true);
  });

  it("routes a message sent to a thread to that thread", async () => {
    const { key, inbox, bot, threads } = await setup();
    await sendGithub(inbox, "pull_request", prPayload(1));
    await settled();
    const [thread] = await threads();
    const sent = await call("POST", `/bots/${bot.id}/threads/${thread!.id}/messages`, { key, body: { text: "hi" } });
    expect(sent.status).toBe(201);
    await settled();
    const after = await threads();
    expect(after).toHaveLength(1);
    expect(after[0]!.waiting).toHaveLength(2);
  });

  it("makes a runner's own /assign of an already routed message a no-op", async () => {
    const { key, inbox, bot, threads } = await setup();
    await sendGithub(inbox, "pull_request", prPayload(1));
    await settled();
    const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
    const messages = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data as {
      id: string;
      seq: number;
    }[];
    const res = await call("POST", `/bots/${bot.id}/assign`, {
      key,
      body: {
        lease_token: lease,
        cursor: messages[0]!.seq,
        assignments: [{ message_id: messages[0]!.id, thread_id: randomUUID(), add_subjects: ["other"] }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(0);
    const all = await threads();
    expect(all).toHaveLength(1);
    expect(all[0]!.subjects).toEqual(["pr-1"]);
  });
});
