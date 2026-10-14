import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignMessages } from "../src/store.js";
import { call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

/** A user with a leased bot over one inbox holding `count` messages. */
async function setup(count = 3) {
  const key = await newUser();
  const inbox = await newInbox(key);
  const bot = (
    await call("POST", "/bots", { key, body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] } })
  ).body;
  for (let i = 1; i <= count; i++) await sendGithub(inbox, "pull_request", prPayload(i));
  const messages = (await call("GET", `/inboxes/${inbox.id}/messages?order=asc`, { key })).body.data as {
    id: string;
    seq: number;
  }[];
  const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
  const base = `/bots/${bot.id}`;
  const assign = (assignments: unknown[], o: { cursor?: number; token?: string } = {}) =>
    call("POST", `${base}/assign`, {
      key,
      body: { lease_token: o.token ?? lease, cursor: o.cursor ?? 0, assignments },
    });
  const thread = (id: string) => call("GET", `${base}/threads/${id}`, { key });
  const runner = randomUUID();
  await call("POST", "/runners", { key, body: { id: runner, name: "laptop" } });
  const runnerLease = (await call("POST", `/runners/${runner}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease
    .token as string;
  /** Claims the thread for the runner; returns the runner's lease token, which thread writes take. */
  const leaseThread = async (id: string) => {
    const r = await call("POST", `${base}/threads/${id}/claim`, { key, body: { lease_token: runnerLease } });
    expect(r.status).toBe(200);
    return runnerLease;
  };
  return { key, inbox, bot, base, messages, lease, assign, thread, runner, runnerLease, leaseThread };
}

describe("thread titles and summaries", () => {
  it("computes them from the stored events, the title from the newest message that has one", async () => {
    const { key, inbox, base, assign, thread } = await setup(0);
    const sender = { login: "alice" };
    await sendGithub(inbox, "issues", {
      action: "opened",
      sender,
      issue: { number: 4, title: "Old title" },
      repository: { url: "u" },
    });
    await sendGithub(inbox, "issue_comment", {
      action: "created",
      sender,
      issue: { number: 4, title: "New title" },
      comment: { body: "Looks good\nsecond line" },
      repository: { url: "u" },
    });
    await sendGithub(inbox, "push", { ref: "refs/heads/main", sender, commits: [{}], repository: { url: "u" } });
    const ms = (await call("GET", `/inboxes/${inbox.id}/messages?order=asc`, { key })).body.data as { id: string }[];
    const id = randomUUID();
    expect((await assign(ms.map((m) => ({ message_id: m.id, thread_id: id, add_subjects: ["o/r#4"] })))).status).toBe(
      200,
    );

    const got = (await thread(id)).body;
    expect(got.title).toBe("New title");
    expect(got.waiting.map((m: any) => m.summary)).toEqual([
      "alice opened issue #4: Old title",
      "alice commented on #4: Looks good",
      "alice pushed 1 commit to main",
    ]);
    const list = (await call("GET", `${base}/threads`, { key })).body.data;
    expect(list[0]).toMatchObject({ title: "New title" });
    expect(list[0].waiting[0].summary).toBe("alice opened issue #4: Old title");
  });

  it("has a null title when no message carries one", async () => {
    const { key, base, messages, assign, thread } = await setup(1);
    const id = randomUUID();
    await assign([{ message_id: messages[0]!.id, thread_id: id }]);
    expect((await thread(id)).body.title).toBeNull();
    expect((await call("GET", `${base}/threads`, { key })).body.data[0].title).toBeNull();
  });
});

describe("thread assignment", () => {
  it("creates threads, subjects and waiting messages, and advances the cursor, in one go", async () => {
    const { key, base, bot, messages, assign, thread } = await setup();
    const t1 = randomUUID();
    const t2 = randomUUID();
    const r = await assign(
      [
        { message_id: messages[0]!.id, thread_id: t1, add_subjects: ["o/r#1"], subject: "o/r#1" },
        { message_id: messages[1]!.id, thread_id: t1 },
        { message_id: messages[2]!.id, thread_id: t2, add_subjects: ["o/r#2", "o/r#3"] },
      ],
      { cursor: 42 },
    );
    expect(r).toMatchObject({ status: 200, body: { assigned: 3 } });
    expect((await call("GET", base, { key })).body.cursor).toBe(42);

    const got = (await thread(t1)).body;
    expect(got).toMatchObject({
      id: t1,
      bot_id: bot.id,
      status: "active",
      started: false,
      subjects: ["o/r#1"],
      delivered: 0,
    });
    expect(got.waiting).toEqual([
      {
        id: messages[0]!.id,
        inbox_id: bot.inbox_ids[0],
        type: "com.github.pull_request.opened",
        subject: "o/r#1",
        summary: null,
      },
      expect.objectContaining({ id: messages[1]!.id, subject: null }),
    ]);
    expect(got.delivered_ids).toEqual([]);
    expect((await thread(t2)).body.subjects).toEqual(["o/r#2", "o/r#3"]);

    const list = (await call("GET", `${base}/threads`, { key })).body.data;
    expect(list.map((t: any) => t.id).sort()).toEqual([t1, t2].sort());
    expect(list[0].delivered_ids).toBeUndefined();
  });

  it("skips a message that is already assigned, and never moves the cursor back", async () => {
    const { key, base, messages, assign } = await setup(2);
    const t1 = randomUUID();
    expect((await assign([{ message_id: messages[0]!.id, thread_id: t1 }], { cursor: 10 })).body.assigned).toBe(1);
    const again = await assign(
      [
        { message_id: messages[0]!.id, thread_id: randomUUID() },
        { message_id: messages[1]!.id, thread_id: t1 },
      ],
      { cursor: 5 },
    );
    expect(again.body.assigned).toBe(1);
    expect((await call("GET", base, { key })).body.cursor).toBe(10);
    expect((await call("GET", `${base}/threads`, { key })).body.data[0].waiting).toHaveLength(2);
  });

  it("changes nothing when the lease is wrong: no threads, no messages, no cursor", async () => {
    const { key, base, bot, messages, assign, lease } = await setup(1);
    const before = (await call("GET", base, { key })).body.cursor;
    const r = await assign([{ message_id: messages[0]!.id, thread_id: randomUUID(), add_subjects: ["a#1"] }], {
      cursor: 99,
      token: "nope",
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("lease_mismatch");
    expect((await call("GET", base, { key })).body.cursor).toBe(before);
    expect((await call("GET", `${base}/threads?status=all`, { key })).body.data).toEqual([]);

    // Expired lease: not_leased.
    await db.query(`UPDATE loopway.bots SET locked_until = now() - interval '1 second' WHERE id = $1`, [bot.id]);
    const expired = await assign([{ message_id: messages[0]!.id, thread_id: randomUUID() }], { token: lease });
    expect(expired.status).toBe(409);
  });

  it("rolls back everything if the statement fails part-way", async () => {
    const { key, base, bot, messages, lease } = await setup(1);
    const other = (
      await call("POST", "/bots", {
        key,
        body: { name: "o", model: "sonnet", harness: "claude", inbox_ids: bot.inbox_ids },
      })
    ).body;
    const tid = randomUUID();
    await db.query(
      `INSERT INTO loopway.threads (id, bot_id, created_by, org_id) SELECT $1, id, 'bot:' || id, org_id FROM loopway.bots WHERE id = $2`,
      [tid, other.id],
    );
    // Skipping the API's checks: the other bot's thread id makes the key insert fail its foreign key, after the
    // cursor update and the new thread have been planned.
    await expect(
      assignMessages(db, bot.id, lease, 77, [
        { message_id: messages[0]!.id, thread_id: randomUUID() },
        { message_id: messages[0]!.id, thread_id: tid, add_subjects: ["a#1"] },
      ]),
    ).rejects.toThrow();
    expect((await call("GET", base, { key })).body.cursor).not.toBe(77);
    expect((await call("GET", `${base}/threads?status=all`, { key })).body.data).toEqual([]);

    // Through the API, the same mistake is a 409.
    const r = await call("POST", `${base}/assign`, {
      key,
      body: { lease_token: lease, cursor: 77, assignments: [{ message_id: messages[0]!.id, thread_id: tid }] },
    });
    expect(r.body.error.code).toBe("thread_exists");
  });

  it("gives a key to one thread per bot", async () => {
    const { key, base, bot, messages, assign } = await setup();
    const t1 = randomUUID();
    await assign([{ message_id: messages[0]!.id, thread_id: t1, add_subjects: ["o/r#1"] }]);

    const clash = await assign([{ message_id: messages[1]!.id, thread_id: randomUUID(), add_subjects: ["o/r#1"] }]);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: "subject_taken", details: { subject: "o/r#1", thread_id: t1 } });
    // The same key on the same thread again is fine, and two threads in one batch can't share one.
    expect((await assign([{ message_id: messages[1]!.id, thread_id: t1, add_subjects: ["o/r#1"] }])).status).toBe(200);
    const dup = await assign([
      { message_id: messages[2]!.id, thread_id: randomUUID(), add_subjects: ["x#1"] },
      { message_id: messages[2]!.id, thread_id: randomUUID(), add_subjects: ["x#1"] },
    ]);
    expect(dup.status).toBe(409);

    // Another bot can use the same key.
    const other = (
      await call("POST", "/bots", {
        key,
        body: { name: "o", model: "sonnet", harness: "claude", inbox_ids: bot.inbox_ids },
      })
    ).body;
    const lease = (await call("POST", `/bots/${other.id}/lease`, { key, body: {} })).body.lease.token;
    const ok = await call("POST", `/bots/${other.id}/assign`, {
      key,
      body: {
        lease_token: lease,
        cursor: 0,
        assignments: [{ message_id: messages[0]!.id, thread_id: randomUUID(), add_subjects: ["o/r#1"] }],
      },
    });
    expect(ok.status).toBe(200);
    // And the database enforces it too.
    await expect(
      db.query(`INSERT INTO loopway.thread_subjects (thread_id, bot_id, subject) VALUES ($1, $2, 'o/r#1')`, [
        t1,
        bot.id,
      ]),
    ).rejects.toThrow();
    expect(base).toBeTruthy();
  });

  it("only takes messages from the bot's inboxes", async () => {
    const { key, assign } = await setup(1);
    const elsewhere = await newInbox(key);
    await sendGithub(elsewhere, "pull_request", prPayload(9));
    const m = (await call("GET", `/inboxes/${elsewhere.id}/messages`, { key })).body.data[0];
    const r = await assign([{ message_id: m.id, thread_id: randomUUID() }]);
    expect(r.status).toBe(400);
  });
});

describe("thread writes", () => {
  it("won't switch a bot's harness while a started thread is active", async () => {
    const { key, bot, base, messages, assign, leaseThread } = await setup(1);
    const t = randomUUID();
    await assign([{ message_id: messages[0]!.id, thread_id: t, add_subjects: ["a#1"] }]);
    const lease = await leaseThread(t);
    const switchTo = () => call("PATCH", `/bots/${bot.id}`, { key, body: { harness: "cursor" } });
    // Not started yet: nothing to resume, so it may switch.
    expect((await switchTo()).body.harness).toBe("cursor");
    await call("PATCH", `/bots/${bot.id}`, { key, body: { harness: "claude" } });

    await call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: lease, started: true } });
    const r = await switchTo();
    expect([r.status, r.body.error.code]).toEqual([409, "harness_in_use"]);
    // Re-sending the current harness is not a change.
    expect((await call("PATCH", `/bots/${bot.id}`, { key, body: { harness: "claude" } })).status).toBe(200);

    await call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: lease, status: "ended" } });
    expect((await switchTo()).body.harness).toBe("cursor");
  });

  it("patches flags, status and subjects under the lease", async () => {
    const { key, base, messages, assign, thread, leaseThread } = await setup(2);
    const t = randomUUID();
    await assign([{ message_id: messages[0]!.id, thread_id: t, add_subjects: ["a#1"] }]);
    const lease = await leaseThread(t);
    const patch = (body: object) =>
      call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: lease, ...body } });

    const r = await patch({ started: true, interrupted: true, add_subjects: ["a#2"] });
    expect(r.body).toMatchObject({
      started: true,
      interrupted: true,
      limited: false,
      status: "active",
      subjects: ["a#1", "a#2"],
    });
    expect((await patch({ status: "ended", interrupted: false })).body).toMatchObject({
      status: "ended",
      interrupted: false,
      started: true,
    });
    expect((await thread(t)).body.status).toBe("ended");
    expect((await call("GET", `${base}/threads`, { key })).body.data).toEqual([]);
    expect((await call("GET", `${base}/threads?status=ended`, { key })).body.data).toHaveLength(1);

    // Wrong lease, unknown thread, key held by another thread.
    expect(
      (await call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: "x", status: "active" } })).status,
    ).toBe(409);
    expect((await thread(t)).body.status).toBe("ended");
    expect((await call("PATCH", `${base}/threads/${randomUUID()}`, { key, body: { lease_token: lease } })).status).toBe(
      404,
    );
    const t2 = randomUUID();
    await assign([{ message_id: messages[1]!.id, thread_id: t2, add_subjects: ["b#1"] }]);
    expect((await patch({ add_subjects: ["b#1"] })).body.error.code).toBe("subject_taken");
  });

  it("delivers waiting messages as inflight, then finishes or requeues them", async () => {
    const { key, base, messages, assign, thread, leaseThread } = await setup(3);
    const t = randomUUID();
    await assign([
      { message_id: messages[0]!.id, thread_id: t },
      { message_id: messages[1]!.id, thread_id: t },
    ]);
    const lease = await leaseThread(t);
    await call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: lease, status: "ended" } });
    const post = (action: string, body: object = {}) =>
      call("POST", `${base}/threads/${t}/${action}`, { key, body: { lease_token: lease, ...body } });

    const d = await post("deliver");
    expect(d.body.data.map((m: any) => m.id)).toEqual([messages[0]!.id, messages[1]!.id]);
    expect(d.body.data[0]).toMatchObject({ inbox_id: expect.any(String), type: "com.github.pull_request.opened" });
    let got = (await thread(t)).body;
    expect(got).toMatchObject({ status: "active", waiting: [], delivered: 0 });
    expect(got.inflight).toHaveLength(2);
    expect((await post("deliver")).body.data).toEqual([]);

    expect((await post("finish", { requeue: true })).body.moved).toBe(2);
    got = (await thread(t)).body;
    expect([got.waiting.length, got.inflight.length, got.delivered]).toEqual([2, 0, 0]);

    await post("deliver");
    expect((await post("finish")).body.moved).toBe(2);
    got = (await thread(t)).body;
    expect([got.waiting.length, got.inflight.length, got.delivered]).toEqual([0, 0, 2]);
    expect(got.delivered_ids).toEqual([messages[0]!.id, messages[1]!.id]);
    expect(got.delivered_messages).toEqual([
      {
        id: messages[0]!.id,
        inbox_id: expect.any(String),
        type: "com.github.pull_request.opened",
        key: null,
        summary: null,
        delivered_at: expect.any(String),
      },
      expect.objectContaining({ id: messages[1]!.id }),
    ]);
    expect((await post("finish")).body.moved).toBe(0);

    // A message that arrives later waits until the next deliver.
    await assign([{ message_id: messages[2]!.id, thread_id: t }]);
    expect((await thread(t)).body).toMatchObject({
      delivered: 2,
      waiting: [expect.objectContaining({ id: messages[2]!.id })],
    });

    for (const action of ["deliver", "finish"])
      expect((await call("POST", `${base}/threads/${t}/${action}`, { key, body: { lease_token: "x" } })).status).toBe(
        409,
      );
    expect((await call("POST", `${base}/threads/${t}/deliver`, { key, body: {} })).status).toBe(400);
    expect(
      (await call("POST", `${base}/threads/${randomUUID()}/deliver`, { key, body: { lease_token: lease } })).status,
    ).toBe(404);
  });

  it("lets the owner end a thread without a lease, leaving its messages and other threads alone", async () => {
    const { key, base, messages, assign, thread, leaseThread, lease } = await setup(3);
    const t = randomUUID();
    const other = randomUUID();
    await assign([
      { message_id: messages[0]!.id, thread_id: t },
      { message_id: messages[1]!.id, thread_id: t },
      { message_id: messages[2]!.id, thread_id: other },
    ]);
    const runnerLease = await leaseThread(t);
    await call("POST", `${base}/threads/${t}/deliver`, { key, body: { lease_token: runnerLease } });
    await assign([]);
    const end = () => call("POST", `${base}/threads/${t}/end`, { key, body: {} });

    const r = await end();
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ended");
    // Same as a runner ending it: the inflight messages stay where they were.
    expect(r.body.inflight).toHaveLength(2);
    expect((await end()).body.status).toBe("ended");
    expect((await thread(other)).body.status).toBe("active");
    expect((await thread(other)).body.waiting).toHaveLength(1);
    expect(
      (await call("POST", `${base}/assign`, { key, body: { lease_token: lease, cursor: 0, assignments: [] } })).status,
    ).toBe(200);
    expect((await call("POST", `${base}/threads/${randomUUID()}/end`, { key, body: {} })).status).toBe(404);

    // The runner's PATCH still needs its lease.
    await call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: runnerLease, status: "active" } });
    expect(
      (await call("PATCH", `${base}/threads/${t}`, { key, body: { lease_token: "x", status: "ended" } })).status,
    ).toBe(409);
    expect((await thread(t)).body.status).toBe("active");
  });

  it("keeps a bot's threads from other users and other bots", async () => {
    const { key, base, messages, assign, lease } = await setup(1);
    const t = randomUUID();
    await assign([{ message_id: messages[0]!.id, thread_id: t, add_subjects: ["a#1"] }]);

    const stranger = await newUser("Other");
    for (const [method, path, body] of [
      ["GET", `${base}/threads`, undefined],
      ["GET", `${base}/threads/${t}`, undefined],
      ["POST", `${base}/assign`, { lease_token: lease, cursor: 0, assignments: [] }],
      ["PATCH", `${base}/threads/${t}`, { lease_token: lease, status: "ended" }],
      ["POST", `${base}/threads/${t}/deliver`, { lease_token: lease }],
      ["POST", `${base}/threads/${t}/finish`, { lease_token: lease }],
      ["POST", `${base}/threads/${t}/end`, {}],
      ["POST", `${base}/threads`, { id: randomUUID(), subjects: [], status: "active", started: false, messages: [] }],
    ] as const)
      expect((await call(method, path, { key: stranger, body })).status, `${method} ${path}`).toBe(404);

    // Another bot of the same user doesn't see the thread, and can't touch it with its own lease.
    const sibling = (
      await call("POST", "/bots", {
        key,
        body: {
          name: "s",
          model: "sonnet",
          harness: "claude",
          inbox_ids: (await call("GET", base, { key })).body.inbox_ids,
        },
      })
    ).body;
    const sLease = (await call("POST", `/bots/${sibling.id}/lease`, { key, body: {} })).body.lease.token;
    expect((await call("GET", `/bots/${sibling.id}/threads/${t}`, { key })).status).toBe(404);
    expect((await call("GET", `/bots/${sibling.id}/threads?status=all`, { key })).body.data).toEqual([]);
    expect(
      (await call("PATCH", `/bots/${sibling.id}/threads/${t}`, { key, body: { lease_token: sLease, status: "ended" } }))
        .status,
    ).toBe(404);
  });
  it("moves a subject and its waiting messages to another thread, and resumes an ended target", async () => {
    const { key, base, messages, assign, thread, leaseThread } = await setup(3);
    const [t1, t2] = [randomUUID(), randomUUID()];
    await assign([
      { message_id: messages[0]!.id, thread_id: t1, add_subjects: ["o/r#1"], subject: "o/r#1" },
      { message_id: messages[1]!.id, thread_id: t1, add_subjects: ["o/r#2"], subject: "o/r#2" },
      { message_id: messages[2]!.id, thread_id: t2, add_subjects: ["o/r#3"], subject: "o/r#3" },
    ]);
    const lease = await leaseThread(t2);
    await call("PATCH", `${base}/threads/${t2}`, { key, body: { lease_token: lease, status: "ended" } });

    const move = (from: string, to: string, subject: string) =>
      call("POST", `${base}/threads/${from}/move-subject`, { key, body: { subject, to_thread_id: to } });
    const moved = await move(t1, t2, "o/r#1");
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: t2, status: "active", subjects: ["o/r#1", "o/r#3"] });
    expect(moved.body.waiting.map((m: any) => m.id).sort()).toEqual([messages[0]!.id, messages[2]!.id].sort());
    const old = (await thread(t1)).body;
    expect(old.subjects).toEqual(["o/r#2"]);
    expect(old.waiting.map((m: any) => m.id)).toEqual([messages[1]!.id]);

    expect((await move(t1, t2, "o/r#1")).status).toBe(404);
    expect((await move(t1, t1, "o/r#2")).status).toBe(400);
    expect((await move(t1, t2, "o/r#9")).status).toBe(404);
    expect((await move(t1, randomUUID(), "o/r#2")).status).toBe(404);
  });

  it("won't move a subject to another bot's thread", async () => {
    const { key, messages, assign } = await setup(1);
    const t1 = randomUUID();
    await assign([{ message_id: messages[0]!.id, thread_id: t1, add_subjects: ["o/r#1"] }]);
    const sibling = (
      await call("POST", "/bots", { key, body: { name: "s", model: "sonnet", harness: "claude", inbox_ids: [] } })
    ).body;
    const r = await call("POST", `/bots/${sibling.id}/threads/${t1}/move-subject`, {
      key,
      body: { subject: "o/r#1", to_thread_id: randomUUID() },
    });
    expect(r.status).toBe(404);
  });
});
