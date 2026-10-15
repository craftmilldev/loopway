import { describe, expect, it } from "vitest";
import { app, call, newUser } from "../helpers.js";

describe("loopway webhooks", () => {
  type LoopwayInbox = {
    id: string;
    webhook_url: string;
    config: { secret: string; events: string[]; schema: Record<string, unknown> };
    setup: Record<string, unknown>;
  };

  async function loopwayInbox(key: string, config?: unknown) {
    const r = await call("POST", "/inboxes", { key, body: { name: "bots", source_type: "loopway", config } });
    expect(r.status).toBe(201);
    return r.body as LoopwayInbox;
  }

  function sendLoopway(inbox: LoopwayInbox, body: unknown, o: { token?: string | null; contentType?: string } = {}) {
    const token = o.token === undefined ? inbox.config.secret : o.token;
    return app.request(`/api/webhooks/${inbox.id}`, {
      method: "POST",
      headers: {
        "content-type": o.contentType ?? "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const SCHEMA = {
    type: "object",
    required: ["type", "id", "data"],
    properties: {
      type: { enum: ["build.finished", "build.failed"] },
      id: { type: "string" },
      data: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
  };

  it("refuses the type reserved for messages sent to a thread", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    const r = await sendLoopway(inbox, { type: "dev.loopway.thread.message", id: "1", data: { thread_id: "t" } });
    expect(r.status).toBe(422);
  });

  it("creates with a token and a default schema, and stores a message as a CloudEvent", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    expect(inbox.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(inbox.config.events).toEqual(["*"]);
    expect(inbox.config.schema).toEqual({ type: "object", required: ["type", "id", "data"] });
    expect(inbox.setup.headers).toEqual({
      authorization: `Bearer ${inbox.config.secret}`,
      "content-type": "application/json",
    });

    const r = await sendLoopway(inbox, { type: "build.finished", id: "build-42", data: { ok: true } });
    expect(r.status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0];
    expect(e.event).toEqual({
      specversion: "1.0",
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      source: inbox.webhook_url,
      type: "build.finished",
      subject: "build.finished/build-42",
      time: expect.any(String),
      datacontenttype: "application/json",
      data: { ok: true },
    });
  });

  it("keeps every message about the same thing, under one subject", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    const msg = { type: "build.finished", id: 42, data: null };
    expect((await sendLoopway(inbox, msg)).status).toBe(202);
    expect((await sendLoopway(inbox, msg)).status).toBe(202);
    const events = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data;
    expect(events.map((e: { event: { subject: string } }) => e.event.subject)).toEqual([
      "build.finished/42",
      "build.finished/42",
    ]);
  });

  it("rejects a missing or wrong token, including user tokens", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    const msg = { type: "t", id: "1", data: {} };
    expect((await sendLoopway(inbox, msg, { token: null })).status).toBe(401);
    expect((await sendLoopway(inbox, msg, { token: "x".repeat(64) })).status).toBe(401);
    expect((await sendLoopway(inbox, msg, { token: key })).status).toBe(401);
  });

  it("checks messages against the inbox schema", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key, { schema: SCHEMA });
    expect(inbox.config.schema).toEqual(SCHEMA);
    expect((await sendLoopway(inbox, { type: "build.failed", id: "b1", data: { ok: false } })).status).toBe(202);

    const bad = await sendLoopway(inbox, { type: "build.finished", id: "b1", data: { ok: "yes" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toBe("Doesn't match the inbox schema: /data/ok must be boolean");
    expect((await sendLoopway(inbox, { type: "deploy", id: "b1", data: { ok: true } })).status).toBe(400);
    expect((await sendLoopway(inbox, { type: "build.failed", data: { ok: true } })).status).toBe(400);
  });

  it("needs a string type and a string or number id even when the schema allows anything", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    expect((await sendLoopway(inbox, { type: 1, id: "1", data: {} })).status).toBe(400);
    expect((await sendLoopway(inbox, { type: "t", id: { a: 1 }, data: {} })).status).toBe(400);
    expect((await sendLoopway(inbox, { id: "1", data: {} })).status).toBe(400);
  });

  it("rejects non-JSON bodies and filtered types", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key, { events: ["build.finished"] });
    const msg = { type: "build.finished", id: "1", data: {} };
    expect((await sendLoopway(inbox, msg, { contentType: "text/plain" })).status).toBe(415);
    expect((await sendLoopway(inbox, "{not json")).status).toBe(400);
    expect((await sendLoopway(inbox, { ...msg, type: "other" })).status).toBe(422);
    expect((await sendLoopway(inbox, msg)).status).toBe(202);
  });

  it("refuses schemas that don't require type, id and data, or aren't valid", async () => {
    const key = await newUser();
    const create = (schema: unknown) =>
      call("POST", "/inboxes", { key, body: { name: "bots", source_type: "loopway", config: { schema } } });
    expect((await create({ type: "object", required: ["type", "id"] })).status).toBe(400);
    expect((await create({ type: "object" })).status).toBe(400);
    expect((await create({ type: "nope", required: ["type", "id", "data"] })).status).toBe(400);

    const inbox = await loopwayInbox(key);
    const r = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { schema: SCHEMA } } });
    expect(r.body.config).toEqual({ secret: inbox.config.secret, events: ["*"], schema: SCHEMA });
  });
});
