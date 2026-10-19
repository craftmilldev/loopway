import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REPLY_TYPE, SETUP_MESSAGE_TYPE } from "@loopway/rules";
import { SETUP_PROMPT } from "../src/setup-bot.js";
import { call, newUser } from "./helpers.js";

async function orgOf(key: string) {
  const orgs = await call("GET", "/orgs", { key });
  return orgs.body.data.find((o: { personal: boolean }) => o.personal).slug as string;
}

describe("the setup bot", () => {
  it("is made on the first pick, hidden, with loopway's prompt", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    expect((await call("GET", `/bots?org=${org}&hidden=include`, { key })).body.data).toEqual([]);
    expect((await call("PUT", "/setup-bot", { key, body: { org, harness: "claude" } })).status).toBe(201);
    const hidden = (await call("GET", `/bots?org=${org}&hidden=include`, { key })).body.data;
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ harness: "claude", model: "sonnet" });
    expect(hidden[0].prompt_version.prompt).toBe(SETUP_PROMPT);
    expect((await call("GET", `/bots?org=${org}`, { key })).body.data).toEqual([]);
  });

  it("moves to the harness picked, and is left out of the lists", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    const made = await call("PUT", "/setup-bot", { key, body: { org, harness: "codex" } });
    expect(made.status).toBe(201);
    expect(made.body.harness).toBe("codex");

    const bot = (await call("GET", `/bots/${made.body.bot_id}`, { key })).body;
    expect(bot).toMatchObject({ harness: "codex", model: "gpt-6-sol", inbox_ids: [made.body.inbox_id] });
    expect(bot.prompt_version.prompt).toBe(SETUP_PROMPT);

    expect((await call("GET", `/bots?org=${org}`, { key })).body.data).toEqual([]);
    expect((await call("GET", "/bots/activity", { key })).body.data).toEqual([]);
    expect((await call("GET", "/inboxes", { key })).body.data).toEqual([]);
    expect((await call("GET", "/inboxes/activity", { key })).body.data).toEqual([]);
    // Runners ask for it.
    expect((await call("GET", `/bots?org=${org}&hidden=include`, { key })).body.data.map((b: any) => b.id)).toEqual([
      made.body.bot_id,
    ]);
  });

  it("is one per org: asking again moves it to another harness", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    const first = await call("PUT", "/setup-bot", { key, body: { org, harness: "claude" } });
    const again = await call("PUT", "/setup-bot", { key, body: { org, harness: "claude" } });
    expect(again.status).toBe(200);
    expect(again.body.bot_id).toBe(first.body.bot_id);
    const moved = await call("PUT", "/setup-bot", { key, body: { org, harness: "cursor" } });
    expect(moved.body).toMatchObject({ bot_id: first.body.bot_id, harness: "cursor" });
    const versions = (await call("GET", `/bots/${first.body.bot_id}/versions`, { key })).body.data;
    expect(versions).toHaveLength(1);
  });

  it("takes only a real harness, in an org the caller belongs to", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    expect((await call("PUT", "/setup-bot", { key, body: { org, harness: "script" } })).status).toBe(400);
    expect((await call("PUT", "/setup-bot", { key, body: { org, harness: "nope" } })).status).toBe(400);
    expect((await call("PUT", "/setup-bot", { key, body: { harness: "claude" } })).body.error?.code).toBe(
      "org_required",
    );
    const other = await newUser("Other");
    expect((await call("PUT", "/setup-bot", { key: other, body: { org, harness: "claude" } })).status).toBe(404);
  });

  it("keeps its prompt loopway's: the user can't change, version or delete it", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    const { bot_id } = (await call("PUT", "/setup-bot", { key, body: { org, harness: "claude" } })).body;
    const rules = [{ types: ["*"], action: "'attach'" }];
    for (const [method, path, body] of [
      ["POST", `/bots/${bot_id}/versions`, { prompt: "mine", rules }],
      ["PATCH", `/bots/${bot_id}`, { name: "mine" }],
      ["DELETE", `/bots/${bot_id}`, undefined],
    ] as const) {
      const res = await call(method, path, { key, body });
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe("bot_hidden");
    }
  });

  it("keeps its inbox loopway's too", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    const { inbox_id } = (await call("PUT", "/setup-bot", { key, body: { org, harness: "claude" } })).body;
    for (const [method, body] of [
      ["PATCH", { name: "mine" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call(method, `/inboxes/${inbox_id}`, { key, body });
      expect(res.status, method).toBe(403);
      expect(res.body.error.code).toBe("inbox_hidden");
    }
  });

  it("takes a message and keeps the reply a runner leaves", async () => {
    const key = await newUser();
    const org = await orgOf(key);
    const { bot_id, inbox_id } = (await call("PUT", "/setup-bot", { key, body: { org, harness: "claude" } })).body;
    expect((await call("POST", "/setup-bot/messages", { key, body: { org, text: "  " } })).status).toBe(400);
    const sent = await call("POST", "/setup-bot/messages", { key, body: { org, text: "which harness?" } });
    expect(sent.status).toBe(201);
    expect(sent.body.inbox_id).toBe(inbox_id);

    const [message] = (await call("GET", `/inboxes/${inbox_id}/messages`, { key })).body.data;
    expect(message.event).toMatchObject({
      type: SETUP_MESSAGE_TYPE,
      subject: "setup",
      data: { text: "which harness?" },
    });

    // The runner reads it into a thread, claims it, and the session replies.
    const runner = randomUUID();
    await call("POST", "/runners", { key, body: { org, id: runner, name: "laptop" } });
    const runnerLease = (await call("POST", `/runners/${runner}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease
      .token as string;
    const botLease = (await call("POST", `/bots/${bot_id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease
      .token as string;
    const thread = randomUUID();
    await call("POST", `/bots/${bot_id}/assign`, {
      key,
      body: {
        lease_token: botLease,
        cursor: 0,
        assignments: [{ message_id: message.id, thread_id: thread, add_subjects: [] }],
      },
    });
    const url = `/bots/${bot_id}/threads/${thread}`;
    const body = (text: string, token = runnerLease) => ({ lease_token: token, text });
    // Not the thread's runner yet.
    expect((await call("POST", `${url}/replies`, { key, body: body("early") })).status).toBe(409);
    await call("POST", `${url}/claim`, { key, body: { lease_token: runnerLease } });
    expect((await call("POST", `${url}/replies`, { key, body: body("x", "wrong") })).status).toBeGreaterThanOrEqual(
      409,
    );
    expect((await call("POST", `${url}/replies`, { key, body: body(" ") })).status).toBe(400);
    expect((await call("POST", `${url}/replies`, { key, body: body("Claude Code.") })).status).toBe(201);

    const replies = (await call("GET", `/inboxes/${inbox_id}/messages?type=${REPLY_TYPE}`, { key })).body.data;
    expect(replies).toHaveLength(1);
    expect(replies[0].event.data).toMatchObject({ text: "Claude Code.", thread_id: thread, bot_id });
  });
});
