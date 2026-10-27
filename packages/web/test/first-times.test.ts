import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assign, call, db, events, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

const named = (name: string) => events.filter((e) => e.event === name);

describe("time to runner and time to first bot", () => {
  it("records each duration once per org, the first time it happens", async () => {
    const key = await newUser();
    const org = (await call("GET", "/orgs", { key })).body.data[0].id as string;
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    await sendGithub(inbox, "pull_request", prPayload(1));
    const message = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0].id as string;
    const base = `/bots/${bot.id}`;
    const thread = randomUUID();
    await assign(bot.id, [{ message_id: message, thread_id: thread }]);

    // Back-date the org so the durations are known.
    await db.query(`UPDATE loopway.orgs SET created_at = now() - interval '100 seconds' WHERE id = $1`, [org]);

    const runner = randomUUID();
    const register = (id: string) => call("POST", "/runners", { key, body: { id, name: "laptop" } });
    await register(runner);
    const first = named("org_first_runner_connected").filter((e) => e.distinctId === org);
    expect(first).toHaveLength(1);
    expect(first[0]!.properties!.seconds).toBeGreaterThanOrEqual(100);
    expect(first[0]!.properties!.seconds).toBeLessThan(160);

    // Registering again, or a second runner, records nothing more.
    await register(runner);
    await register(randomUUID());
    expect(named("org_first_runner_connected").filter((e) => e.distinctId === org)).toHaveLength(1);

    const token = (await call("POST", `/runners/${runner}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
    const other = await call("POST", `/runners/${runner}/lease`, { key, body: { ttl_seconds: 60 } });
    expect(other.status).toBe(409);
    expect(named("runner_lease_rejected")).toMatchObject([{ distinctId: org, properties: { reason: "leased" } }]);

    // A bot has only run once a message is delivered, not when it's merely picked up or put back.
    const post = (action: string, body: object = {}) =>
      call("POST", `${base}/threads/${thread}/${action}`, { key, body: { lease_token: token, ...body } });
    await call("POST", `${base}/threads/${thread}/claim`, { key, body: { lease_token: token } });
    await post("deliver");
    await post("finish", { requeue: true });
    expect(named("org_first_bot_ran").filter((e) => e.distinctId === org)).toHaveLength(0);
    await post("deliver");
    await post("finish");
    const ran = named("org_first_bot_ran").filter((e) => e.distinctId === org);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.properties!.seconds).toBeGreaterThanOrEqual(100);

    // Later deliveries add nothing.
    await post("deliver");
    await post("finish");
    expect(named("org_first_bot_ran").filter((e) => e.distinctId === org)).toHaveLength(1);
  });
});
