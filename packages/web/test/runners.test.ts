import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

/** A user with a bot (its lease held), two messages, a registered runner (not leased) and a thread of the first. */
async function setup() {
  const key = await newUser();
  const inbox = await newInbox(key);
  const bot = (
    await call("POST", "/bots", { key, body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] } })
  ).body;
  for (const n of [1, 2]) await sendGithub(inbox, "pull_request", prPayload(n));
  const messages = (await call("GET", `/inboxes/${inbox.id}/messages?order=asc`, { key })).body.data.map(
    (m: { id: string }) => m.id,
  ) as string[];
  const base = `/bots/${bot.id}`;
  const lease = (await call("POST", `${base}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token as string;
  const runner = randomUUID();
  await call("POST", "/runners", { key, body: { id: runner, name: "laptop" } });
  const thread = randomUUID();
  const assigned = await call("POST", `${base}/assign`, {
    key,
    body: { lease_token: lease, cursor: 0, assignments: [{ message_id: messages[0], thread_id: thread }] },
  });
  expect(assigned.status).toBe(200);

  const newRunner = async (name: string) => {
    const id = randomUUID();
    await call("POST", "/runners", { key, body: { id, name } });
    return id;
  };
  const leaseRunner = (id: string, body: object = {}) => call("POST", `/runners/${id}/lease`, { key, body });
  const claim = (token: string, id = thread) =>
    call("POST", `${base}/threads/${id}/claim`, { key, body: { lease_token: token } });
  const patch = (token: string) =>
    call("PATCH", `${base}/threads/${thread}`, { key, body: { lease_token: token, status: "ended" } });
  const get = async () => (await call("GET", `${base}/threads/${thread}`, { key })).body;
  return { key, base, bot, messages, lease, runner, thread, newRunner, leaseRunner, claim, patch, get };
}

describe("runners", () => {
  it("registers idempotently, per user, and lists what they hold", async () => {
    const { key, base, bot, lease, runner, thread, leaseRunner, claim } = await setup();
    const renamed = await call("POST", "/runners", { key, body: { id: runner, name: "renamed" } });
    expect(renamed.body).toMatchObject({ id: runner, name: "renamed", leased_until: null, bots: [], threads: 0 });
    expect((await call("GET", "/runners", { key })).body.data).toHaveLength(1);
    expect((await call("POST", "/runners", { key, body: { id: "nope", name: "x" } })).status).toBe(400);

    const stranger = await newUser("Other");
    expect((await call("POST", "/runners", { key: stranger, body: { id: runner, name: "mine" } })).status).toBe(409);
    expect((await call("GET", "/runners", { key: stranger })).body.data).toEqual([]);
    expect((await call("POST", `/runners/${runner}/lease`, { key: stranger, body: {} })).status).toBe(404);
    const theirs = (await call("POST", "/runners", { key: stranger, body: { id: randomUUID(), name: "t" } })).body;
    const asTheirs = await call("POST", `${base}/lease`, { key, body: { lease_token: lease, runner_id: theirs.id } });
    expect(asTheirs.status).toBe(404);

    await call("POST", `${base}/lease`, { key, body: { lease_token: lease, runner_id: runner } });
    const token = (await leaseRunner(runner)).body.lease.token;
    await claim(token);
    const listed = (await call("GET", "/runners", { key })).body.data[0];
    expect(listed).toMatchObject({ bots: [{ id: bot.id, name: "b" }], threads: 1, leased_until: expect.any(String) });
    expect(listed.lock_token).toBeUndefined();
    expect((await call("GET", `${base}/threads/${thread}`, { key })).body.runner_id).toBe(runner);

    // Releasing the bot lease clears who holds it.
    await call("POST", `${base}/release`, { key, body: { lease_token: lease } });
    expect((await call("GET", "/runners", { key })).body.data[0].bots).toEqual([]);
  });

  it("is leased to one process at a time", async () => {
    const { key, runner, leaseRunner } = await setup();
    const release = (body: object, id = runner) => call("POST", `/runners/${id}/release`, { key, body });

    const token = (await leaseRunner(runner, { ttl_seconds: 60 })).body.lease.token;
    // A second process is refused; the holder renews with its token and keeps it.
    const second = await leaseRunner(runner);
    expect(second).toMatchObject({ status: 409, body: { error: { code: "runner_leased" } } });
    expect(second.body.error.details.expires_at).toEqual(expect.any(String));
    expect((await leaseRunner(runner, { lease_token: token })).body.lease.token).toBe(token);
    expect((await leaseRunner(randomUUID())).status).toBe(404);

    expect((await release({})).status).toBe(400);
    expect((await release({ lease_token: "x" })).status).toBe(409);
    expect((await release({ lease_token: token })).status).toBe(204);
    const taken = (await leaseRunner(runner)).body.lease.token;
    expect(taken).not.toBe(token);

    // A process that died without releasing: forced release, or the lease expiring.
    expect((await release({ force: true })).status).toBe(204);
    expect((await leaseRunner(runner)).status).toBe(200);
    await db.query(`UPDATE loopway.runners SET locked_until = now() - interval '1 second' WHERE id = $1`, [runner]);
    expect((await leaseRunner(runner)).status).toBe(200);
  });
});

describe("thread ownership", () => {
  it("goes to the runner that claims the thread, and thread writes need that runner's lease", async () => {
    const { key, base, runner, thread, newRunner, leaseRunner, claim, patch, get } = await setup();
    const other = await newRunner("desktop");

    // Unclaimed, writes fail, even with a live runner lease.
    const token = (await leaseRunner(runner)).body.lease.token;
    const otherToken = (await leaseRunner(other)).body.lease.token;
    expect((await patch("x")).body.error.code).toBe("runner_not_leased");
    expect((await patch(token)).body.error.code).toBe("thread_unclaimed");

    expect((await claim("x")).body.error.code).toBe("runner_not_leased");
    expect((await claim(token)).body).toMatchObject({ id: thread, runner_id: runner });
    expect((await claim(token)).status).toBe(200);
    expect((await patch(token)).status).toBe(200);

    // Owned: another runner can't claim it or write it, even with a live lease of its own.
    expect(await claim(otherToken)).toMatchObject({ status: 409, body: { error: { code: "thread_owned" } } });
    expect((await patch(otherToken)).body.error).toMatchObject({
      code: "thread_owned",
      details: { runner_id: runner },
    });
    expect((await get()).runner_id).toBe(runner);
    expect((await claim(token, randomUUID())).status).toBe(404);

    // Ownership doesn't expire with the lease: the same runner takes a new lease and carries on.
    await call("POST", `/runners/${runner}/release`, { key, body: { lease_token: token } });
    expect((await patch(token)).body.error.code).toBe("runner_not_leased");
    expect((await get()).runner_id).toBe(runner);
    const again = (await leaseRunner(runner)).body.lease.token;
    expect((await patch(again)).status).toBe(200);
    expect((await patch(otherToken)).body.error.code).toBe("thread_owned");

    // Moving it takes an explicit release, after which the other runner can claim it.
    const released = await call("POST", `${base}/threads/${thread}/release`, { key, body: {} });
    expect(released.body.runner_id).toBeNull();
    expect((await patch(again)).body.error.code).toBe("thread_unclaimed");
    expect((await claim(otherToken)).body.runner_id).toBe(other);
    expect((await patch(otherToken)).status).toBe(200);
    expect((await call("GET", "/runners", { key })).body.data.map((r: any) => [r.id, r.threads])).toEqual(
      expect.arrayContaining([
        [runner, 0],
        [other, 1],
      ]),
    );
  });

  it("is checked in the write itself, not just before it", async () => {
    const { key, base, runner, thread, leaseRunner, claim } = await setup();
    const token = (await leaseRunner(runner)).body.lease.token;
    await claim(token);
    // The lease lapses between the precheck and the write: the statement still refuses.
    await db.query(`UPDATE loopway.runners SET locked_until = now() - interval '1 second' WHERE id = $1`, [runner]);
    const store = await import("../src/store.js");
    expect(await store.patchThread(db, base.split("/")[2]!, token, thread, { status: "ended" })).toBe(false);
    expect(await store.deliverThread(db, base.split("/")[2]!, token, thread)).toBeUndefined();
    expect(await store.finishThread(db, base.split("/")[2]!, token, thread, false)).toBeUndefined();
    expect((await call("GET", `${base}/threads/${thread}`, { key })).body.status).toBe("active");
  });
});

describe("a runner's org", () => {
  /** A user in their personal org and in a shared one. */
  async function twoOrgs() {
    const key = await newUser("Both");
    const id = randomUUID();
    const slug = `shared-${id.slice(0, 8)}`;
    await db.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
    const me = (await call("GET", "/me", { key })).body.id;
    await db.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, 'test')`, [id, me]);
    const orgs = (await call("GET", "/orgs", { key })).body.data as { slug: string; personal: boolean }[];
    return { key, shared: slug, personal: orgs.find((o) => o.personal)!.slug };
  }

  it("is required, and must be one the caller is in", async () => {
    const { key, shared } = await twoOrgs();
    const none = await call("POST", "/runners", { key, noOrg: true, body: { id: randomUUID(), name: "x" } });
    expect([none.status, none.body.error.code]).toEqual([400, "org_required"]);
    const stranger = await newUser("Out");
    const out = await call("POST", "/runners", { key: stranger, body: { org: shared, id: randomUUID(), name: "x" } });
    expect([out.status, out.body.error.code]).toEqual([404, "not_found"]);
    const made = await call("POST", "/runners", { key, body: { org: shared, id: randomUUID(), name: "x" } });
    expect(made.status).toBe(200);
    expect(made.body.org).toBe(shared);
    expect((await call("GET", `/runners?org=${shared}`, { key })).body.data[0].org).toBe(shared);
  });

  it("is kept: the same id in another org is a 409, in its own org it is a rename", async () => {
    const { key, shared, personal } = await twoOrgs();
    const id = randomUUID();
    await call("POST", "/runners", { key, body: { org: shared, id, name: "laptop" } });
    const moved = await call("POST", "/runners", { key, body: { org: personal, id, name: "laptop" } });
    expect([moved.status, moved.body.error.code]).toEqual([409, "runner_org_mismatch"]);
    expect(moved.body.error.details).toEqual({ org: shared });
    const renamed = await call("POST", "/runners", { key, body: { org: shared, id, name: "renamed" } });
    expect(renamed.body).toMatchObject({ name: "renamed", org: shared });
    // Someone outside the runner's org learns nothing about it.
    const stranger = await newUser("Out");
    const taken = await call("POST", "/runners", { key: stranger, body: { id, name: "mine" } });
    expect([taken.status, taken.body.error.code]).toEqual([409, "runner_exists"]);
  });

  it("can't lease or claim a bot of another org, even for a user in both", async () => {
    const { key, shared, personal } = await twoOrgs();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    await sendGithub(inbox, "pull_request", prPayload(1));
    const message = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0].id;
    const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: {} })).body.lease.token;
    const thread = randomUUID();
    await call("POST", `/bots/${bot.id}/assign`, {
      key,
      body: { lease_token: lease, cursor: 0, assignments: [{ message_id: message, thread_id: thread }] },
    });

    const runner = randomUUID();
    await call("POST", "/runners", { key, body: { org: shared, id: runner, name: "laptop" } });
    const token = (await call("POST", `/runners/${runner}/lease`, { key, body: {} })).body.lease.token;

    const leased = await call("POST", `/bots/${bot.id}/lease`, {
      key,
      body: { lease_token: lease, runner_id: runner },
    });
    expect([leased.status, leased.body.error.code]).toEqual([400, "runner_org_mismatch"]);
    const claimed = await call("POST", `/bots/${bot.id}/threads/${thread}/claim`, {
      key,
      body: { lease_token: token },
    });
    expect([claimed.status, claimed.body.error.code]).toEqual([400, "runner_org_mismatch"]);
    expect((await call("GET", `/bots/${bot.id}/threads/${thread}`, { key })).body.runner_id).toBeNull();

    // A runner of the bot's own org does both.
    const own = randomUUID();
    await call("POST", "/runners", { key, body: { org: personal, id: own, name: "desktop" } });
    const ownToken = (await call("POST", `/runners/${own}/lease`, { key, body: {} })).body.lease.token;
    const ok = await call("POST", `/bots/${bot.id}/threads/${thread}/claim`, { key, body: { lease_token: ownToken } });
    expect(ok.status).toBe(200);
  });

  describe("poll", () => {
    it("renews the runner's lease, leases the bots it asks for and reports what waits, in one call", async () => {
      const { key, base, bot, runner, thread, claim, messages, newRunner } = await setup();
      const poll = (id: string, body: object) => call("POST", `/runners/${id}/poll`, { key, body });

      const first = await poll(runner, { ttl_seconds: 60, bots: [{ id: bot.id }] });
      expect(first.status).toBe(200);
      const token = first.body.lease.token as string;
      const bots = first.body.bots as any[];
      expect(bots).toHaveLength(1);
      // The test's own lease on the bot was taken without a runner, so it holds the bot until it ends.
      expect(bots[0]).toMatchObject({ id: bot.id, name: "b", harness: "claude", unread: false, lease: null });
      expect(bots[0].leased_until).toBeTruthy();
      expect(first.body.threads).toEqual([]);

      // Another process can't use the runner while it's leased, and the poll says so like the lease call.
      const taken = await poll(runner, { bots: [] });
      expect(taken.status).toBe(409);
      expect(taken.body.error.code).toBe("runner_leased");
      expect((await poll(runner, { lease_token: token, bots: [] })).body.lease.token).toBe(token);

      // Free the bot, and the poll takes its lease for the runner, then renews it with the token.
      await call("POST", `${base}/release`, { key, body: { force: true } });
      const leased = await poll(runner, { lease_token: token, bots: [{ id: bot.id }] });
      const lease = leased.body.bots[0].lease;
      expect(lease.token).toBeTruthy();
      expect(leased.body.bots[0].leased_until).toBeNull();
      const again = await poll(runner, { lease_token: token, bots: [{ id: bot.id, lease_token: lease.token }] });
      expect(again.body.bots[0].lease.token).toBe(lease.token);
      // Another runner doesn't get it, and is told until when.
      const other = await newRunner("other");
      const refused = await poll(other, { bots: [{ id: bot.id }] });
      const otherToken = refused.body.lease.token as string;
      expect(refused.body.bots[0]).toMatchObject({ lease: null });
      expect(refused.body.bots[0].leased_until).toBeTruthy();
      // `lease: false` only reports.
      const peek = await poll(runner, { lease_token: token, bots: [{ id: bot.id, lease: false }] });
      expect(peek.body.bots[0].lease).toBeNull();

      // The second message is unread (the first was assigned, but the cursor is still at 0), once past the holdback.
      await db.query(`UPDATE loopway.messages SET received_at = received_at - interval '1 minute'`);
      expect((await poll(runner, { lease_token: token, bots: [] })).body.bots[0].unread).toBe(true);

      // The runner's threads with a message waiting come with the poll, and not with draining.
      await claim(token);
      const work = await poll(runner, { lease_token: token, bots: [] });
      expect(work.body.threads.map((t: { id: string }) => t.id)).toEqual([thread]);
      expect(work.body.threads[0].waiting).toHaveLength(1);
      expect(work.body.threads[0].waiting[0].id).toBe(messages[0]);
      expect((await poll(runner, { lease_token: token, bots: [], draining: true })).body.threads).toEqual([]);
      expect((await poll(other, { lease_token: otherToken, bots: [] })).body.threads).toEqual([]);
    });

    it("skips bots of other orgs and refuses a runner that isn't yours", async () => {
      const { key, bot, runner } = await setup();
      const stranger = await newUser("Other");
      expect((await call("POST", `/runners/${runner}/poll`, { key: stranger, body: { bots: [] } })).status).toBe(404);
      const theirs = (await call("POST", "/runners", { key: stranger, body: { id: randomUUID(), name: "t" } })).body;
      const res = await call("POST", `/runners/${theirs.id}/poll`, { key: stranger, body: { bots: [{ id: bot.id }] } });
      expect(res.status).toBe(200);
      expect(res.body.bots).toEqual([]);
      expect((await call("GET", `/bots/${bot.id}`, { key })).body.runner_id).toBeNull();
    });
  });
});
