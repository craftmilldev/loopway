import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newSource, newUser, readAll } from "../helpers.js";

describe("granola webhooks", () => {
  const GRANOLA_SECRET = "whsec_" + Buffer.from("granola-test-signing-key").toString("base64");

  const granolaSource = (key: string, secret: string | undefined = GRANOLA_SECRET) =>
    newSource(key, { type: "granola", secret });

  function sendGranola(userId: string, payload: unknown, o: { id?: string; secret?: string; timestamp?: number } = {}) {
    const raw = JSON.stringify(payload);
    const id = o.id ?? randomUUID();
    const ts = String(o.timestamp ?? Math.floor(Date.now() / 1000));
    const key = Buffer.from((o.secret ?? GRANOLA_SECRET).slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
    return app.request(`/api/webhooks/${userId}`, {
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
    const source = await granolaSource(key);
    expect((await sendGranola(source.userId, note(), { id: "evt-1" })).status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.event).toMatchObject({
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

  it("registers without a secret and rejects deliveries until one is set", async () => {
    const key = await newUser();
    const source = await newSource(key, { type: "granola" });
    expect(source).toMatchObject({ secret_set: false });
    expect(source).not.toHaveProperty("secret");
    const early = await sendGranola(source.userId, note());
    expect(early.status).toBe(401);
    expect((await early.json()).error.code).toBe("unverified");
    const bad = await call("PATCH", `/sources/${source.id}`, { key, body: { secret: "not-a-whsec" } });
    expect(bad.status).toBe(400);
    const r = await call("PATCH", `/sources/${source.id}`, { key, body: { secret: GRANOLA_SECRET } });
    expect(r.body.secret_set).toBe(true);
    expect((await sendGranola(source.userId, note())).status).toBe(202);
  });

  it("refuses to register a secret that isn't a whsec_ one", async () => {
    const key = await newUser();
    const r = await call("POST", "/sources", { key, body: { type: "granola", secret: "not-a-whsec" } });
    expect(r.status).toBe(400);
  });

  it("rejects bad signatures and stale timestamps", async () => {
    const key = await newUser();
    const source = await granolaSource(key);
    const other = "whsec_" + Buffer.from("some-other-key").toString("base64");
    expect((await sendGranola(source.userId, note(), { secret: other })).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect((await sendGranola(source.userId, note(), { timestamp: stale })).status).toBe(401);
    expect(await readAll(key)).toHaveLength(0);
  });

  it("acknowledges a signed delivery about no note (Granola's test event) without storing it", async () => {
    const key = await newUser();
    const source = await granolaSource(key);
    const r = await sendGranola(source.userId, { event_id: "t-1", event_type: "webhook.test" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ignored: true, reason: "no_note:webhook.test" });
    const bare = await sendGranola(source.userId, {});
    expect(await bare.json()).toEqual({ ignored: true, reason: "no_note" });
    expect(
      (
        await sendGranola(
          source.userId,
          { event_type: "webhook.test" },
          { secret: "whsec_" + Buffer.from("x").toString("base64") },
        )
      ).status,
    ).toBe(401);
    expect(await readAll(key)).toHaveLength(0);
  });

  it("rejects a note event with no event_type", async () => {
    const key = await newUser();
    const source = await granolaSource(key);
    expect((await sendGranola(source.userId, { note_id: "not_1" })).status).toBe(400);
  });

  it("dedupes redeliveries", async () => {
    const key = await newUser();
    const source = await granolaSource(key);
    expect((await sendGranola(source.userId, note(), { id: "same" })).status).toBe(202);
    const dup = await sendGranola(source.userId, note(), { id: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
  });
});
