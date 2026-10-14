import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

// The audit behind "nobody creates, edits or deletes data in an org they aren't a member of": every route is
// either listed as public here or answers 401 without a token, and every route that names a resource answers
// 404 (or a refusal) for a user outside the resource's org, leaving the org's data as it was.

// Public on purpose: the shell, health, signed webhooks, login, and the analytics proxy.
const PUBLIC = [
  /^GET \/api\/?$/,
  /^GET \/api\/health$/,
  /^POST \/api\/webhooks\/:inboxId$/,
  /^POST \/api\/auth\/(login|verify)$/,
  // The UI shell, its bundle and llms.txt (GETs that serve no account data), and the analytics proxy.
  /^GET \/(login|orgs\/new|app\.js|app\.css|llms\.txt)?$/,
  /^GET \/dashboard(\/|$)/,
  // The pages of an org, which show nothing until the browser has loaded the org from the API.
  /^GET \/:org(\/|$)/,
  /^ALL \/api\/ingest\//,
  // The database middleware, which runs for every request and answers nothing itself.
  /^ALL \/\*$/,
];

describe("authentication", () => {
  it("covers every API route that isn't public", async () => {
    const routes = [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].filter(
      (r) => !PUBLIC.some((p) => p.test(r)),
    );
    let checked = 0;
    for (const route of routes) {
      const [method, path] = route.split(" ") as [string, string];
      const res = await app.request(path.replace(/:\w+/g, randomUUID()), { method });
      expect(res.status, route).toBe(401);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe("ownership", () => {
  it("keeps one user's inboxes, messages, bots, runners and threads from another", async () => {
    const owner = await newUser("owner");
    const stranger = await newUser("stranger");
    const inbox = await newInbox(owner);
    await sendGithub(inbox, "pull_request", prPayload(1));
    const message = (await call("GET", `/inboxes/${inbox.id}/messages`, { key: owner })).body.data[0] as { id: string };
    const bot = (
      await call("POST", "/bots", { key: owner, body: { name: "b", model: "sonnet", inbox_ids: [inbox.id] } })
    ).body;
    const botLease = (await call("POST", `/bots/${bot.id}/lease`, { key: owner, body: {} })).body.lease.token;
    const runner = randomUUID();
    await call("POST", "/runners", { key: owner, body: { id: runner, name: "laptop" } });
    const runnerLease = (await call("POST", `/runners/${runner}/lease`, { key: owner, body: {} })).body.lease.token;
    const thread = randomUUID();
    const assigned = await call("POST", `/bots/${bot.id}/assign`, {
      key: owner,
      body: { lease_token: botLease, cursor: 0, assignments: [{ message_id: message.id, thread_id: thread }] },
    });
    expect(assigned.status).toBe(200);
    const snapshot = async () => ({
      inbox: (await call("GET", `/inboxes/${inbox.id}`, { key: owner })).body,
      bot: (await call("GET", `/bots/${bot.id}`, { key: owner })).body,
      versions: (await call("GET", `/bots/${bot.id}/versions`, { key: owner })).body,
      threads: (await call("GET", `/bots/${bot.id}/threads?status=all`, { key: owner })).body,
      runners: (await call("GET", "/runners", { key: owner })).body,
    });
    const before = await snapshot();

    const b = `/bots/${bot.id}`;
    const t = `${b}/threads/${thread}`;
    const attempts: [string, string, unknown?][] = [
      ["GET", `/inboxes/${inbox.id}`],
      ["PATCH", `/inboxes/${inbox.id}`, { name: "mine now" }],
      ["DELETE", `/inboxes/${inbox.id}`],
      ["GET", `/inboxes/${inbox.id}/messages`],
      ["GET", `/inboxes/${inbox.id}/messages/${message.id}`],
      ["GET", b],
      ["PATCH", b, { name: "mine now" }],
      ["DELETE", b],
      ["GET", `${b}/activity`],
      ["GET", `${b}/versions`],
      ["POST", `${b}/versions`, { prompt: "take over" }],
      ["POST", `${b}/lease`, {}],
      ["POST", `${b}/release`, { force: true }],
      ["POST", `${b}/release`, { lease_token: botLease }],
      ["POST", `${b}/cursor`, { seq: 99, lease_token: botLease }],
      ["GET", `${b}/messages`],
      ["GET", `${b}/threads`],
      ["GET", t],
      ["POST", `${t}/claim`, { lease_token: runnerLease }],
      ["POST", `${t}/release`, {}],
      ["PATCH", t, { lease_token: runnerLease, status: "ended" }],
      ["POST", `${t}/move-subject`, { subject: "x", to_thread_id: thread }],
      ["POST", `${t}/deliver`, { lease_token: runnerLease }],
      ["POST", `${t}/finish`, { lease_token: runnerLease }],
      ["POST", `${b}/assign`, { lease_token: botLease, cursor: 0, assignments: [] }],
      ["POST", `/runners/${runner}/lease`, { force: true }],
      ["POST", `/runners/${runner}/release`, { force: true }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, { key: stranger, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // Taking over a runner id, or a bot's lease through a runner that isn't theirs, is refused.
    expect((await call("POST", "/runners", { key: stranger, body: { id: runner, name: "mine" } })).status).toBe(409);
    const mineInbox = await newInbox(stranger);
    const mineBot = (
      await call("POST", "/bots", { key: stranger, body: { name: "m", model: "sonnet", inbox_ids: [mineInbox.id] } })
    ).body;
    expect(
      (await call("POST", `/bots/${mineBot.id}/lease`, { key: stranger, body: { runner_id: runner } })).status,
    ).toBe(404);
    // A stranger's bot can't be pointed at the owner's inbox, or have its assignments reach the owner's messages.
    expect(
      (await call("PATCH", `/bots/${mineBot.id}`, { key: stranger, body: { inbox_ids: [inbox.id] } })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/bots", { key: stranger, body: { name: "x", model: "sonnet", inbox_ids: [inbox.id] } }))
        .status,
    ).toBe(400);
    // Activity covers only the caller's own bots.
    const activity = (await call("GET", "/bots/activity", { key: stranger })).body.data as { bot_id: string }[];
    expect(activity.map((a) => a.bot_id)).toEqual([mineBot.id]);
    const mineLease = (await call("POST", `/bots/${mineBot.id}/lease`, { key: stranger, body: {} })).body.lease.token;
    const reach = await call("POST", `/bots/${mineBot.id}/assign`, {
      key: stranger,
      body: {
        lease_token: mineLease,
        cursor: 0,
        assignments: [{ message_id: message.id, thread_id: randomUUID() }],
      },
    });
    expect(reach.status).toBe(400);
    const reuse = await call("POST", `/bots/${mineBot.id}/assign`, {
      key: stranger,
      body: { lease_token: mineLease, cursor: 0, assignments: [{ message_id: message.id, thread_id: thread }] },
    });
    expect([400, 409]).toContain(reuse.status);

    // Lists show a user only their own.
    for (const list of ["/inboxes", "/bots", "/runners"]) {
      const ids = ((await call("GET", list, { key: stranger })).body.data as { id: string }[]).map((r) => r.id);
      expect(ids, list).not.toContain(inbox.id);
      expect(ids, list).not.toContain(bot.id);
      expect(ids, list).not.toContain(runner);
    }

    expect(await snapshot()).toEqual(before);
    const [row] = await db.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM loopway.bots WHERE id = $1`, [
      bot.id,
    ]);
    expect(row?.deleted_at).toBeNull();
    expect((await call("GET", "/events", { key: stranger })).body.data).toEqual([]);

    // A member of the owner's org reaches every one of those, and sees them in lists.
    const member = await newUser("member");
    // A personal org takes no other member, so the owner's org stops being personal for this check.
    const ownerOrg = await personalOrg(owner);
    await db.query(`UPDATE loopway.orgs SET personal_user_id = NULL WHERE id = $1`, [ownerOrg]);
    await join(member, ownerOrg);
    for (const [method, path, body] of attempts) {
      if (method === "DELETE" || path.endsWith("/release") || path.endsWith("/end")) continue;
      const res = await call(method, path, { key: member, body });
      expect(res.status, `member ${method} ${path}`).not.toBe(404);
      expect(res.status, `member ${method} ${path}`).toBeLessThan(500);
    }
    for (const list of ["/inboxes", "/bots", "/runners"]) {
      const ids = ((await call("GET", list, { key: member })).body.data as { id: string }[]).map((r) => r.id);
      expect(ids.length, list).toBeGreaterThan(0);
    }
    const memberActivity = (await call("GET", "/bots/activity", { key: member })).body.data as { bot_id: string }[];
    expect(memberActivity.map((a) => a.bot_id)).toContain(bot.id);
    expect((await call("GET", `/inboxes/${inbox.id}/activity`, { key: member })).status).toBe(200);
    expect((await call("GET", "/events", { key: member })).body.data.length).toBeGreaterThan(0);
    expect((await call("DELETE", b, { key: member })).status).toBe(204);
  });

  it("shares an org's entities between its members, and keeps orgs apart", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const shared = await newOrg();
    await join(a, shared);
    await join(b, shared);
    // Fixtures in the shared org, which nothing can create into yet.
    const aId = await userId(a);
    const inbox = { id: randomUUID() };
    const bot = { id: randomUUID() };
    await db.query(
      `INSERT INTO loopway.inboxes (id, created_by, org_id, name, source_type, config) VALUES ($1, $2, $3, 'gh', 'github', '{"secret":"s3cret","events":["pull_request"]}')`,
      [inbox.id, `user:${aId}`, shared],
    );
    await db.query(
      `INSERT INTO loopway.bots (id, created_by, org_id, name, model, cursor) VALUES ($1, $2, $3, 'b', 'sonnet', 0)`,
      [bot.id, `user:${aId}`, shared],
    );
    await db.query(`INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id) VALUES ($1, $2, $3)`, [
      bot.id,
      inbox.id,
      shared,
    ]);

    // Both members operate on the shared bot; what b creates goes to b's personal org.
    for (const key of [a, b]) {
      expect((await call("GET", `/bots/${bot.id}`, { key })).status).toBe(200);
      expect((await call("PATCH", `/bots/${bot.id}`, { key, body: { name: "n" } })).status).toBe(200);
    }
    const mine = await newInbox(b);
    expect((await call("GET", `/inboxes/${mine.id}`, { key: b })).body.org_id).toBe(await personalOrg(b));
    const ids = ((await call("GET", "/inboxes", { key: b })).body.data as { id: string }[]).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([inbox.id, mine.id]));
    const aIds = ((await call("GET", "/inboxes", { key: a })).body.data as { id: string }[]).map((i) => i.id);
    expect(aIds).not.toContain(mine.id);

    // Tying entities of different orgs together is a 400, not a 500.
    expect((await call("PATCH", `/bots/${bot.id}`, { key: b, body: { inbox_ids: [mine.id] } })).status).toBe(400);
    const runner = randomUUID();
    await call("POST", "/runners", { key: b, body: { id: runner, name: "laptop" } });
    const lease = await call("POST", `/bots/${bot.id}/lease`, { key: b, body: { runner_id: runner } });
    expect(lease.status).toBe(400);
    expect(lease.body.error.code).toBe("runner_org_mismatch");

    // Someone who leaves the org loses it.
    await db.query(`DELETE FROM loopway.org_members WHERE org_id = $1 AND user_id = $2`, [shared, await userId(b)]);
    expect((await call("GET", `/bots/${bot.id}`, { key: b })).status).toBe(404);
  });
});

async function userId(key: string): Promise<string> {
  return (await call("GET", "/me", { key })).body.id;
}

async function personalOrg(key: string): Promise<string> {
  const [org] = await db.query<{ id: string }>(`SELECT id FROM loopway.orgs WHERE personal_user_id = $1`, [
    await userId(key),
  ]);
  return org!.id;
}

async function newOrg(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $2)`, [id, `org-${id.slice(0, 8)}`]);
  return id;
}

async function join(key: string, orgId: string): Promise<void> {
  await db.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, 'test')`, [
    orgId,
    await userId(key),
  ]);
}
