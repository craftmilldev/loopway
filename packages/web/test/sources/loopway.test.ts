import { describe, expect, it } from "vitest";
import { app, newSource, newUser, readAll } from "../helpers.js";

describe("loopway webhooks", () => {
  type LoopwaySource = Awaited<ReturnType<typeof newSource>>;

  const loopwaySource = (key: string) => newSource(key, { type: "loopway" });

  function sendLoopway(source: LoopwaySource, body: unknown, o: { token?: string | null; contentType?: string } = {}) {
    const token = o.token === undefined ? source.secret : o.token;
    return app.request(`/api/webhooks/${source.userId}`, {
      method: "POST",
      headers: {
        "content-type": o.contentType ?? "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("registers with a token, and stores a message as a CloudEvent", async () => {
    const key = await newUser();
    const source = await loopwaySource(key);
    expect(source.secret).toMatch(/^[0-9a-f]{64}$/);

    const r = await sendLoopway(source, { type: "build.finished", id: "build-42", data: { ok: true } });
    expect(r.status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.event).toEqual({
      specversion: "1.0",
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      source: source.webhook_url,
      type: "build.finished",
      subject: "build.finished/build-42",
      time: expect.any(String),
      datacontenttype: "application/json",
      data: { ok: true },
    });
  });

  it("keeps every message about the same thing, under one subject", async () => {
    const key = await newUser();
    const source = await loopwaySource(key);
    const msg = { type: "build.finished", id: 42, data: null };
    expect((await sendLoopway(source, msg)).status).toBe(202);
    expect((await sendLoopway(source, msg)).status).toBe(202);
    const messages = await readAll(key);
    expect(messages.map((m) => m.event.subject)).toEqual(["build.finished/42", "build.finished/42"]);
  });

  it("rejects a missing or wrong token, including user tokens", async () => {
    const key = await newUser();
    const source = await loopwaySource(key);
    const msg = { type: "t", id: "1", data: {} };
    expect((await sendLoopway(source, msg, { token: null })).status).toBe(401);
    expect((await sendLoopway(source, msg, { token: "x".repeat(64) })).status).toBe(401);
    expect((await sendLoopway(source, msg, { token: key })).status).toBe(401);
    expect(await readAll(key)).toHaveLength(0);
  });

  it("needs a string type and a string or number id", async () => {
    const key = await newUser();
    const source = await loopwaySource(key);
    expect((await sendLoopway(source, { type: 1, id: "1", data: {} })).status).toBe(400);
    expect((await sendLoopway(source, { type: "t", id: { a: 1 }, data: {} })).status).toBe(400);
    expect((await sendLoopway(source, { id: "1", data: {} })).status).toBe(400);
    expect((await sendLoopway(source, { type: "t", data: {} })).status).toBe(400);
  });

  it("rejects non-JSON bodies", async () => {
    const key = await newUser();
    const source = await loopwaySource(key);
    const msg = { type: "build.finished", id: "1", data: {} };
    expect((await sendLoopway(source, msg, { contentType: "text/plain" })).status).toBe(415);
    expect((await sendLoopway(source, "{not json")).status).toBe(400);
    expect((await sendLoopway(source, msg)).status).toBe(202);
  });
});
