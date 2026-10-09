import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

/** A user with a bot (its lease held), one message, a registered runner and a thread of that message. */
async function setup() {
  const key = await newUser();
  const inbox = await newInbox(key);
  const bot = (await call("POST", "/bots", { key, body: { name: "b", kind: "k", inbox_ids: [inbox.id] } })).body;
  await sendGithub(inbox, "pull_request", prPayload(1));
  const message = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0].id as string;
  const base = `/bots/${bot.id}`;
  const lease = (await call("POST", `${base}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token as string;
  const runner = randomUUID();
  await call("POST", "/runners", { key, body: { id: runner, name: "laptop" } });
  const thread = randomUUID();
  const assigned = await call("POST", `${base}/assign`, {
    key,
    body: { lease_token: lease, cursor: 0, assignments: [{ message_id: message, thread_id: thread }] },
  });
  expect(assigned.status).toBe(200);
  const leaseThread = (body: object, id = thread) => call("POST", `${base}/threads/${id}/lease`, { key, body });
  const patch = (token: string) =>
    call("PATCH", `${base}/threads/${thread}`, { key, body: { lease_token: token, status: "ended" } });
  return { key, base, bot, lease, runner, thread, leaseThread, patch };
}

describe("runners", () => {
  it("registers idempotently, per user, and lists what they hold", async () => {
    const { key, base, bot, lease, runner, thread, leaseThread } = await setup();
    const renamed = await call("POST", "/runners", { key, body: { id: runner, name: "renamed" } });
    expect(renamed.body).toMatchObject({ id: runner, name: "renamed", bots: [], threads: 0 });
    expect((await call("GET", "/runners", { key })).body.data).toHaveLength(1);
    expect((await call("POST", "/runners", { key, body: { id: "nope", name: "x" } })).status).toBe(400);

    const stranger = await newUser("Other");
    expect((await call("POST", "/runners", { key: stranger, body: { id: runner, name: "mine" } })).status).toBe(409);
    expect((await call("GET", "/runners", { key: stranger })).body.data).toEqual([]);
    const theirs = (await call("POST", "/runners", { key: stranger, body: { id: randomUUID(), name: "t" } })).body;
    const asTheirs = await call("POST", `${base}/lease`, { key, body: { lease_token: lease, runner_id: theirs.id } });
    expect(asTheirs.status).toBe(404);

    await call("POST", `${base}/lease`, { key, body: { lease_token: lease, runner_id: runner } });
    await leaseThread({ runner_id: runner });
    const listed = (await call("GET", "/runners", { key })).body.data[0];
    expect(listed).toMatchObject({ bots: [{ id: bot.id, name: "b" }], threads: 1 });
    const got = (await call("GET", `${base}/threads/${thread}`, { key })).body;
    expect(got).toMatchObject({ runner_id: runner, leased_until: expect.any(String) });
    expect(got.lock_token).toBeUndefined();

    // Releasing the bot lease clears who holds it.
    await call("POST", `${base}/release`, { key, body: { lease_token: lease } });
    expect((await call("GET", "/runners", { key })).body.data[0].bots).toEqual([]);
  });
});

describe("thread leases", () => {
  it("go to one runner at a time, and thread writes need them", async () => {
    const { key, base, runner, thread, leaseThread, patch } = await setup();
    const other = randomUUID();
    await call("POST", "/runners", { key, body: { id: other, name: "desktop" } });

    // Unleased, writes fail; the bot's lease doesn't count.
    expect((await patch("x")).body.error.code).toBe("thread_not_leased");

    const token = (await leaseThread({ runner_id: runner, ttl_seconds: 60 })).body.lease.token;
    expect((await patch(token)).status).toBe(200);
    // Held: another runner is refused, the holder can renew with its token.
    const refused = await leaseThread({ runner_id: other });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "leased", details: { runner_id: runner } } } });
    expect((await patch("x")).body.error.code).toBe("thread_lease_mismatch");
    expect((await leaseThread({ runner_id: runner, lease_token: token })).body.lease.token).toBe(token);
    expect((await leaseThread({ runner_id: randomUUID() })).status).toBe(404);
    expect((await leaseThread({ runner_id: runner }, randomUUID())).status).toBe(404);

    // Released, the other runner can take it, and the old token stops working.
    const release = (lease_token: string) =>
      call("POST", `${base}/threads/${thread}/release`, { key, body: { lease_token } });
    expect((await release("x")).status).toBe(409);
    expect((await release(token)).status).toBe(204);
    expect((await call("GET", `${base}/threads/${thread}`, { key })).body).toMatchObject({
      runner_id: null,
      leased_until: null,
    });
    const taken = (await leaseThread({ runner_id: other })).body.lease.token;
    expect(taken).not.toBe(token);
    expect((await patch(token)).status).toBe(409);
    expect((await patch(taken)).status).toBe(200);

    // An expired lease is up for grabs.
    await db.query(`UPDATE loopway.threads SET locked_until = now() - interval '1 second' WHERE id = $1`, [thread]);
    expect((await patch(taken)).body.error.code).toBe("thread_not_leased");
    expect((await leaseThread({ runner_id: runner })).status).toBe(200);
  });
});
