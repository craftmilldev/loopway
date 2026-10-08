import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newUser } from "../helpers.js";

describe("loopway webhooks", () => {
  async function loopwayInbox(key: string, config?: unknown) {
    const r = await call("POST", "/inboxes", { key, body: { name: "bots", source_type: "loopway", config } });
    expect(r.status).toBe(201);
    return r.body as { id: string; config: { events: string[] }; setup: Record<string, unknown> };
  }

  function sendLoopway(inboxId: string, body: unknown, o: { token?: string; contentType?: string } = {}) {
    return app.request(`/webhooks/${inboxId}`, {
      method: "POST",
      headers: {
        "content-type": o.contentType ?? "application/cloudevents+json",
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const build = (id: string = randomUUID(), type = "com.example.build.finished") => ({
    specversion: "1.0",
    id,
    source: "https://ci.example.com/builds",
    type,
    subject: "build-42",
    time: "2026-10-08T16:00:00+02:00",
    datacontenttype: "application/json",
    data: { ok: true },
  });

  it("stores a CloudEvent sent with any user's API token as sent", async () => {
    const owner = await newUser();
    const bot = await newUser("Bot");
    const inbox = await loopwayInbox(owner);
    expect(inbox.config).toEqual({ events: ["*"] });
    expect(inbox.setup.endpoint_url).toBe(`https://loopway.test/webhooks/${inbox.id}`);

    expect((await sendLoopway(inbox.id, { ...build("evt-1"), traceid: "t1" }, { token: bot })).status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/events`, { key: owner })).body.data[0];
    expect(e.event).toEqual({
      specversion: "1.0",
      id: "evt-1",
      source: "https://ci.example.com/builds",
      type: "com.example.build.finished",
      subject: "build-42",
      time: "2026-10-08T14:00:00.000Z",
      datacontenttype: "application/json",
      data: { ok: true },
      traceid: "t1",
    });
  });

  it("fills in specversion and time when they're left out", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    const body = { id: "evt-1", source: "bot", type: "com.example.ping" };
    expect((await sendLoopway(inbox.id, body, { token: key, contentType: "application/json" })).status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/events`, { key })).body.data[0];
    expect(e.event).toMatchObject({ specversion: "1.0", ...body, time: expect.any(String) });
  });

  it("rejects a missing or invalid token", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    expect((await sendLoopway(inbox.id, build())).status).toBe(401);
    expect((await sendLoopway(inbox.id, build(), { token: "not-a-token" })).status).toBe(401);
  });

  it("rejects bodies that aren't CloudEvents", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key);
    expect((await sendLoopway(inbox.id, build(), { token: key, contentType: "text/plain" })).status).toBe(415);
    expect((await sendLoopway(inbox.id, "{not json", { token: key })).status).toBe(400);
    const r = await sendLoopway(inbox.id, { ...build(), type: undefined }, { token: key });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/^Not a CloudEvent: type/);
    expect((await sendLoopway(inbox.id, { ...build(), specversion: "0.3" }, { token: key })).status).toBe(400);
    expect((await sendLoopway(inbox.id, { ...build(), time: "yesterday" }, { token: key })).status).toBe(400);
    expect((await sendLoopway(inbox.id, { ...build(), "Bad-Name": 1 }, { token: key })).status).toBe(400);
  });

  it("dedupes resends, rejects filtered types, and takes no secret", async () => {
    const key = await newUser();
    const inbox = await loopwayInbox(key, { events: ["com.example.build.finished"] });
    expect((await sendLoopway(inbox.id, build("same"), { token: key })).status).toBe(202);
    const dup = await sendLoopway(inbox.id, build("same"), { token: key });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    const filtered = await sendLoopway(inbox.id, build(undefined, "com.example.other"), { token: key });
    expect(filtered.status).toBe(422);
    expect((await call("GET", `/inboxes/${inbox.id}/events`, { key })).body.data).toHaveLength(1);

    const r = await call("POST", "/inboxes", {
      key,
      body: { name: "bots", source_type: "loopway", config: { secret: "x".repeat(32) } },
    });
    expect(r.status).toBe(400);
  });
});
