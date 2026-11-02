import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newUser } from "../helpers.js";

describe("granola webhooks", () => {
  const GRANOLA_SECRET = "whsec_" + Buffer.from("granola-test-signing-key").toString("base64");

  async function granolaInbox(key: string, config: unknown = { secret: GRANOLA_SECRET }) {
    const r = await call("POST", "/inboxes", { key, body: { name: "granola", source_type: "granola", config } });
    expect(r.status).toBe(201);
    return r.body as {
      id: string;
      config: { secret: string | null; events: string[] };
      setup: Record<string, unknown>;
    };
  }

  function sendGranola(
    inboxId: string,
    payload: unknown,
    o: { id?: string; secret?: string; timestamp?: number } = {},
  ) {
    const raw = JSON.stringify(payload);
    const id = o.id ?? randomUUID();
    const ts = String(o.timestamp ?? Math.floor(Date.now() / 1000));
    const key = Buffer.from((o.secret ?? GRANOLA_SECRET).slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
    return app.request(`/api/webhooks/${inboxId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": ts,
        "webhook-signature": `v1,${sig}`,
      },
      body: raw,
    });
  }

  const note = (eventType = "note.generated") => ({
    event_id: "evt-1",
    event_type: eventType,
    note_id: "not_1d3tmYTlCICgjy",
    occurred_at: "2026-01-27T15:30:00Z",
  });

  it("stores a signed event as a CloudEvent", async () => {
    const key = await newUser();
    const inbox = await granolaInbox(key);
    expect((await sendGranola(inbox.id, note(), { id: "evt-1" })).status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0];
    expect(e.event).toMatchObject({
      specversion: "1.0",
      id: "evt-1",
      type: "ai.granola.note.generated",
      source: "https://public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy",
      subject: "not_1d3tmYTlCICgjy",
      time: "2026-01-27T15:30:00.000Z",
      datacontenttype: "application/json",
      data: note(),
    });
  });

  it("starts without a secret and rejects deliveries until one is set", async () => {
    const key = await newUser();
    const inbox = await granolaInbox(key, {});
    expect(inbox.config).toEqual({ events: ["*"], secret_set: false });
    expect(inbox.setup.secret).toMatch(/not set yet/);
    expect((await sendGranola(inbox.id, note())).status).toBe(401);
    const bad = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: "not-a-whsec" } } });
    expect(bad.status).toBe(400);
    const r = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: GRANOLA_SECRET } } });
    expect(r.body.config).toEqual({ events: ["*"], secret_set: true });
    expect((await sendGranola(inbox.id, note())).status).toBe(202);
  });

  it("rejects bad signatures, stale timestamps and filtered events", async () => {
    const key = await newUser();
    const inbox = await granolaInbox(key, { secret: GRANOLA_SECRET, events: ["note.generated"] });
    const other = "whsec_" + Buffer.from("some-other-key").toString("base64");
    expect((await sendGranola(inbox.id, note(), { secret: other })).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect((await sendGranola(inbox.id, note(), { timestamp: stale })).status).toBe(401);
    const filtered = await sendGranola(inbox.id, note("note.edited"));
    expect(filtered.status).toBe(422);
    expect((await filtered.json()).error.message).toBe('event "note.edited" not enabled for this inbox');
    expect((await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data).toHaveLength(0);
  });

  it("acknowledges a signed delivery about no note (Granola's test event) without storing it", async () => {
    const key = await newUser();
    const inbox = await granolaInbox(key);
    const r = await sendGranola(inbox.id, { event_id: "t-1", event_type: "webhook.test" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ignored: true, reason: "no_note:webhook.test" });
    const bare = await sendGranola(inbox.id, {});
    expect(await bare.json()).toEqual({ ignored: true, reason: "no_note" });
    expect(
      (
        await sendGranola(
          inbox.id,
          { event_type: "webhook.test" },
          { secret: "whsec_" + Buffer.from("x").toString("base64") },
        )
      ).status,
    ).toBe(401);
    expect((await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data).toHaveLength(0);
  });

  it("rejects a note event with no event_type", async () => {
    const key = await newUser();
    const inbox = await granolaInbox(key);
    expect((await sendGranola(inbox.id, { note_id: "not_1" })).status).toBe(400);
  });

  it("dedupes redeliveries", async () => {
    const key = await newUser();
    const inbox = await granolaInbox(key);
    expect((await sendGranola(inbox.id, note(), { id: "same" })).status).toBe(202);
    const dup = await sendGranola(inbox.id, note(), { id: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
  });
});
