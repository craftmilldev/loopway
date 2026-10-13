import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, db, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

// The audit behind "a user never creates, edits or deletes data in another user's account": every route is
// either listed as public here or answers 401 without a token, and every route that names a resource answers
// 404 (or a refusal) for a user who doesn't own it, leaving the owner's data as it was.

// Public on purpose: the shell, health, signed webhooks, login, and the analytics proxy.
const PUBLIC = [/^GET \/api$/, /^GET \/health$/, /^POST \/webhooks\/:inboxId$/, /^POST \/auth\/(login|verify)$/];

describe("authentication", () => {
  it("covers every API route that isn't public", async () => {
    const routes = [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].filter(
      (r) => /^\w+ \/(me|sources|inboxes|runners|bots)\b/.test(r) && !PUBLIC.some((p) => p.test(r)),
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
  });
});
