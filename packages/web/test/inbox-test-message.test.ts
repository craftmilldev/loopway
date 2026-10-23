import { describe, expect, it } from "vitest";
import { call, events, newUser } from "./helpers.js";

const WHSEC = "whsec_" + Buffer.from("a signing secret for the tests").toString("base64");

// One inbox per source type, with the secret the sender would have shown for the senders that make their own.
const SOURCES: { type: string; config?: unknown; message: string }[] = [
  { type: "github", message: "com.github.pull_request.opened" },
  { type: "loopway", message: "test" },
  { type: "linear", config: { secret: "lin_wh_secret" }, message: "com.linear.issue.create" },
  { type: "vercel", config: { secret: "vercel-secret" }, message: "com.vercel.deployment.created" },
  { type: "granola", config: { secret: WHSEC }, message: "ai.granola.note.generated" },
  { type: "resend", config: { secret: WHSEC }, message: "com.resend.email.delivered" },
  {
    type: "schedule",
    config: { schedule: { every: "hour" }, messages: [{ type: "digest", message: "Daily digest" }] },
    message: "dev.craftmill.loopway.schedule.digest",
  },
];

async function makeInbox(key: string, type: string, config?: unknown) {
  const r = await call("POST", "/inboxes", { key, body: { name: type, source_type: type, config } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("POST /inboxes/:id/test", () => {
  for (const s of SOURCES) {
    it(`stores a signed ${s.type} sample flagged as a test`, async () => {
      const key = await newUser();
      const id = await makeInbox(key, s.type, s.config);
      const sent = await call("POST", `/inboxes/${id}/test`, { key, body: { from: "inbox_page" } });
      expect(sent.status).toBe(201);
      expect(sent.body.seq).toBeGreaterThan(0);

      const list = await call("GET", `/inboxes/${id}/messages`, { key });
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ id: sent.body.message_id, seq: sent.body.seq });
      expect(list.body.data[0].event).toMatchObject({ type: s.message, loopwaytest: true });
    });
  }

  it("stores a new message each time", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "github");
    const a = await call("POST", `/inboxes/${id}/test`, { key });
    const b = await call("POST", `/inboxes/${id}/test`, { key });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.seq).toBeGreaterThan(a.body.seq);
  });

  it("sends the first type the events filter accepts", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "github", { events: ["push"] });
    expect((await call("POST", `/inboxes/${id}/test`, { key })).status).toBe(201);
    const [message] = (await call("GET", `/inboxes/${id}/messages`, { key })).body.data;
    expect(message.event).toMatchObject({ type: "com.github.push", loopwaytest: true });
  });

  it("sends a loopway inbox's own type when it accepts only that", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "loopway", { events: ["build.finished"] });
    expect((await call("POST", `/inboxes/${id}/test`, { key })).status).toBe(201);
    const [message] = (await call("GET", `/inboxes/${id}/messages`, { key })).body.data;
    expect(message.event.type).toBe("build.finished");
  });

  it("answers 422 no_accepted_type when the filter lets no sample through", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "github", { events: ["star"] });
    const r = await call("POST", `/inboxes/${id}/test`, { key, body: { from: "cli" } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("no_accepted_type");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "test_message_failed",
        properties: { source_type: "github", from: "cli", reason: "no_accepted_type" },
      }),
    );
  });

  it("answers 409 secret_not_set until a sender's secret is pasted in", async () => {
    const key = await newUser();
    for (const type of ["linear", "vercel", "granola", "resend"]) {
      const id = await makeInbox(key, type);
      const r = await call("POST", `/inboxes/${id}/test`, { key });
      expect(r.status, type).toBe(409);
      expect(r.body.error.code).toBe("secret_not_set");
      expect(r.body.error.message).toContain("paste");
      expect((await call("GET", `/inboxes/${id}/messages`, { key })).body.data).toEqual([]);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "test_message_failed",
        properties: { source_type: "vercel", from: "cli", reason: "secret_not_set" },
      }),
    );
  });

  it("reports a sample the inbox's schema refuses as api_error", async () => {
    const key = await newUser();
    const schema = { type: "object", required: ["type", "id", "data"], properties: { data: { required: ["nope"] } } };
    const id = await makeInbox(key, "loopway", { schema });
    const r = await call("POST", `/inboxes/${id}/test`, { key, body: { from: "zero_state" } });
    expect(r.status).toBe(400);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "test_message_failed",
        properties: { source_type: "loopway", from: "zero_state", reason: "api_error" },
      }),
    );
  });

  it("records test_message_sent with the source and where it came from", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "github");
    await call("POST", `/inboxes/${id}/test`, { key, body: { from: "zero_state" } });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "test_message_sent",
        properties: { source_type: "github", from: "zero_state" },
      }),
    );
  });

  it("rejects an unknown `from`", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "github");
    expect((await call("POST", `/inboxes/${id}/test`, { key, body: { from: "elsewhere" } })).status).toBe(400);
  });

  it("is for members of the inbox's org only", async () => {
    const owner = await newUser("owner");
    const stranger = await newUser("stranger");
    const id = await makeInbox(owner, "github");
    expect((await call("POST", `/inboxes/${id}/test`, { key: stranger })).status).toBe(404);
    expect((await call("POST", `/inboxes/${id}/test`)).status).toBe(401);
    expect((await call("GET", `/inboxes/${id}/messages`, { key: owner })).body.data).toEqual([]);
  });

  it("can't be faked through the public webhook", async () => {
    const key = await newUser();
    const id = await makeInbox(key, "loopway");
    const secret = (await call("GET", `/inboxes/${id}`, { key })).body.config.secret_set;
    expect(secret).toBe(true);
    // A real delivery that names the flag itself is stored without it: only the test route adds it.
    const created = await call("POST", "/inboxes", {
      key,
      body: { name: "known", source_type: "loopway", config: { secret: "a-known-secret-1234" } },
    });
    const res = await (
      await import("./helpers.js")
    ).app.request(`/api/webhooks/${created.body.id}`, {
      method: "POST",
      headers: { authorization: "Bearer a-known-secret-1234", "content-type": "application/json" },
      body: JSON.stringify({ type: "x", id: "1", data: { loopwaytest: true } }),
    });
    expect(res.status).toBe(202);
    const [message] = (await call("GET", `/inboxes/${created.body.id}/messages`, { key })).body.data;
    expect(message.event.loopwaytest).toBeUndefined();
  });
});
