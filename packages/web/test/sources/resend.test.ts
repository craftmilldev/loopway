import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newUser } from "../helpers.js";

describe("resend webhooks", () => {
  const RESEND_SECRET = "whsec_" + Buffer.from("resend-test-signing-key").toString("base64");

  async function resendInbox(key: string, config: unknown = { secret: RESEND_SECRET }) {
    const r = await call("POST", "/inboxes", { key, body: { name: "resend", source_type: "resend", config } });
    expect(r.status).toBe(201);
    return r.body as {
      id: string;
      config: { secret: string | null; events: string[] };
      setup: Record<string, unknown>;
    };
  }

  function sendResend(inboxId: string, payload: unknown, o: { id?: string; secret?: string; timestamp?: number } = {}) {
    const raw = JSON.stringify(payload);
    const id = o.id ?? `msg_${randomUUID()}`;
    const ts = String(o.timestamp ?? Math.floor(Date.now() / 1000));
    const key = Buffer.from((o.secret ?? RESEND_SECRET).slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
    return app.request(`/api/webhooks/${inboxId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": ts,
        "svix-signature": `v1,${sig}`,
      },
      body: raw,
    });
  }

  const email = (type = "email.delivered") => ({
    type,
    created_at: "2026-10-15T12:00:00.000Z",
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      from: "Acme <onboarding@resend.dev>",
      to: ["delivered@resend.dev"],
      subject: "Welcome to Acme",
    },
  });

  it("stores a signed event as a CloudEvent", async () => {
    const key = await newUser();
    const inbox = await resendInbox(key);
    expect((await sendResend(inbox.id, email(), { id: "msg_1" })).status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0];
    expect(e.event).toMatchObject({
      specversion: "1.0",
      id: "msg_1",
      type: "com.resend.email.delivered",
      source: "https://api.resend.com/emails/56761188-7520-42d8-8898-ff6fc54ce618",
      subject: "56761188-7520-42d8-8898-ff6fc54ce618",
      time: "2026-10-15T12:00:00.000Z",
      datacontenttype: "application/json",
      data: email(),
    });
  });

  it("starts without a secret and rejects deliveries until one is set", async () => {
    const key = await newUser();
    const inbox = await resendInbox(key, {});
    expect(inbox.config).toEqual({ secret: null, events: ["*"] });
    expect(inbox.setup.secret).toMatch(/not set yet/);
    expect((await sendResend(inbox.id, email())).status).toBe(401);
    const bad = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: "not-a-whsec" } } });
    expect(bad.status).toBe(400);
    const r = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: RESEND_SECRET } } });
    expect(r.body.config).toEqual({ secret: RESEND_SECRET, events: ["*"] });
    expect((await sendResend(inbox.id, email())).status).toBe(202);
  });

  it("rejects bad signatures, stale timestamps and filtered events", async () => {
    const key = await newUser();
    const inbox = await resendInbox(key, { secret: RESEND_SECRET, events: ["email.bounced"] });
    const other = "whsec_" + Buffer.from("some-other-key").toString("base64");
    expect((await sendResend(inbox.id, email("email.bounced"), { secret: other })).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect((await sendResend(inbox.id, email("email.bounced"), { timestamp: stale })).status).toBe(401);
    const filtered = await sendResend(inbox.id, email("email.delivered"));
    expect(filtered.status).toBe(422);
    expect((await filtered.json()).error.message).toBe('event "email.delivered" not enabled for this inbox');
    expect((await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data).toHaveLength(0);
  });

  it("accepts events that aren't about an email", async () => {
    const key = await newUser();
    const inbox = await resendInbox(key);
    const domain = { type: "domain.updated", created_at: "2026-10-15T12:00:00.000Z", data: { id: "dom_1" } };
    expect((await sendResend(inbox.id, domain)).status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0];
    expect(e.event).toMatchObject({ source: "https://api.resend.com", subject: "dom_1" });
  });

  it("dedupes redeliveries", async () => {
    const key = await newUser();
    const inbox = await resendInbox(key);
    expect((await sendResend(inbox.id, email(), { id: "same" })).status).toBe(202);
    const dup = await sendResend(inbox.id, email(), { id: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
  });
});
