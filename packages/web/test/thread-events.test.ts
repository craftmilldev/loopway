import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

/** A user with a leased bot, a runner, and `count` threads (one message each) assigned and claimed. */
async function setup(count = 1) {
  const key = await newUser();
  const inbox = await newInbox(key);
  const bot = (
    await call("POST", "/bots", {
      key,
      body: { name: "dev", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
    })
  ).body;
  for (let i = 1; i <= count; i++) await sendGithub(inbox, "pull_request", prPayload(i));
  const messages = (await call("GET", `/inboxes/${inbox.id}/messages?order=asc`, { key })).body.data as {
    id: string;
  }[];
  const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
  const runner = randomUUID();
  await call("POST", "/runners", { key, body: { id: runner, name: "laptop" } });
  const runnerLease = (await call("POST", `/runners/${runner}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease
    .token as string;
  const base = `/bots/${bot.id}`;
  const threads = messages.map(() => randomUUID());
  const assigned = await call("POST", `${base}/assign`, {
    key,
    body: {
      lease_token: lease,
      cursor: 0,
      assignments: messages.map((m, i) => ({
        message_id: m.id,
        thread_id: threads[i],
        add_subjects: [`o/r#${i + 1}`],
      })),
    },
  });
  expect(assigned.status).toBe(200);
  for (const t of threads)
    await call("POST", `${base}/threads/${t}/claim`, { key, body: { lease_token: runnerLease } });
  const patch = (thread: string, body: object) =>
    call("PATCH", `${base}/threads/${thread}`, { key, body: { lease_token: runnerLease, ...body } });
  const events = async (query = "") => (await call("GET", "/events" + query, { key })).body;
  return { key, bot, base, threads, patch, events };
}

const kinds = (body: { data: { kind: string }[] }) => body.data.map((e) => e.kind);

describe("thread events", () => {
  it("writes one event per transition and none for a value a flag already has", async () => {
    const { threads, patch, events } = await setup();
    const t = threads[0]!;
    expect(kinds(await events())).toEqual(["created"]);
    await patch(t, { started: true });
    await patch(t, { started: true });
    await patch(t, { interrupted: true, limited: true });
    await patch(t, { limited: true, interrupted: true });
    await patch(t, { limited: false });
    await patch(t, { limited: false });
    await patch(t, { status: "ended" });
    await patch(t, { status: "ended" });
    expect(kinds(await events()).reverse()).toEqual([
      "created",
      "started",
      "interrupted",
      "limited",
      "limit_cleared",
      "ended",
    ]);
  });

  it("records the owner ending a thread once, and not when it's already ended", async () => {
    const { key, base, threads, events } = await setup();
    await call("POST", `${base}/threads/${threads[0]}/end`, { key });
    await call("POST", `${base}/threads/${threads[0]}/end`, { key });
    expect(kinds(await events())).toEqual(["ended", "created"]);
  });

  it("lists newest first with the bot, subjects and title, and pages with next", async () => {
    const { threads, patch, events, bot } = await setup(2);
    await patch(threads[0]!, { started: true });
    await patch(threads[1]!, { started: true });
    const all = await events();
    expect(all.next).toBeNull();
    expect(all.data).toHaveLength(4);
    expect(all.data[0]).toMatchObject({ kind: "started", bot_id: bot.id, bot_name: "dev", thread_id: threads[1] });
    expect(all.data[0].subjects).toEqual(["o/r#2"]);
    expect(all.data[0]).toHaveProperty("title");

    const first = await events("?limit=3");
    expect(first.data).toHaveLength(3);
    expect(first.next).toBe(first.data[2].id);
    const second = await events(`?limit=3&before=${first.next}`);
    expect(second.next).toBeNull();
    expect([...first.data, ...second.data].map((e: { id: string }) => e.id)).toEqual(
      all.data.map((e: { id: string }) => e.id),
    );
  });

  it("rejects a bad limit or cursor", async () => {
    const { key } = await setup(0);
    for (const q of ["?limit=0", "?limit=101", "?before=abc"])
      expect((await call("GET", "/events" + q, { key })).status, q).toBe(400);
  });

  it("never shows another user's events, even through their cursor", async () => {
    const owner = await setup();
    const stranger = await setup();
    const mine = await owner.events();
    const theirs = await stranger.events();
    expect(mine.data).toHaveLength(1);
    expect(theirs.data).toHaveLength(1);
    expect(theirs.data[0].thread_id).not.toBe(mine.data[0].thread_id);
    const probe = await call("GET", `/events?before=${mine.data[0].id}`, { key: stranger.key });
    // Someone else's cursor is no cursor: it pages nothing rather than leaking where it points.
    expect(probe.body.data).toEqual([]);
  });

  it("hides a deleted bot's events, and removes them with the bot or thread rows", async () => {
    const { key, bot, threads, events } = await setup(2);
    expect((await events()).data).toHaveLength(2);
    expect((await call("DELETE", `/bots/${bot.id}`, { key })).status).toBeLessThan(300);
    expect((await events()).data).toEqual([]);
    const count = () => db.query(`SELECT 1 FROM loopway.thread_events WHERE bot_id = $1::uuid`, [bot.id]);
    expect(await count()).toHaveLength(2);
    await db.query(`DELETE FROM loopway.threads WHERE id = $1::uuid`, [threads[0]]);
    expect(await count()).toHaveLength(1);
    await db.query(`DELETE FROM loopway.bots WHERE id = $1::uuid`, [bot.id]);
    expect(await count()).toEqual([]);
  });
});
