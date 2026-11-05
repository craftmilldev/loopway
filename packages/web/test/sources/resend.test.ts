import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newSource, newUser, readAll } from "../helpers.js";

describe("resend webhooks", () => {
  const RESEND_SECRET = "whsec_" + Buffer.from("resend-test-signing-key").toString("base64");

  const resendSource = (key: string) => newSource(key, { type: "resend", secret: RESEND_SECRET });

  function sendResend(userId: string, payload: unknown, o: { id?: string; secret?: string; timestamp?: number } = {}) {
    const raw = JSON.stringify(payload);
    const id = o.id ?? `msg_${randomUUID()}`;
    const ts = String(o.timestamp ?? Math.floor(Date.now() / 1000));
    const key = Buffer.from((o.secret ?? RESEND_SECRET).slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
    return app.request(`/api/webhooks/${userId}`, {
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
    const source = await resendSource(key);
    expect((await sendResend(source.userId, email(), { id: "msg_1" })).status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.event).toMatchObject({
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

  it("registers without a secret and rejects deliveries until one is set", async () => {
    const key = await newUser();
    const source = await newSource(key, { type: "resend" });
    expect(source).toMatchObject({ secret_set: false });
    expect(source).not.toHaveProperty("secret");
    const early = await sendResend(source.userId, email());
    expect(early.status).toBe(401);
    expect((await early.json()).error.code).toBe("unverified");
    const bad = await call("PATCH", `/sources/${source.id}`, { key, body: { secret: "not-a-whsec" } });
    expect(bad.status).toBe(400);
    const r = await call("PATCH", `/sources/${source.id}`, { key, body: { secret: RESEND_SECRET } });
    expect(r.body.secret_set).toBe(true);
    expect((await sendResend(source.userId, email())).status).toBe(202);
  });

  it("refuses to register a secret that isn't a whsec_ one", async () => {
    const key = await newUser();
    const r = await call("POST", "/sources", { key, body: { type: "resend", secret: "not-a-whsec" } });
    expect(r.status).toBe(400);
  });

  it("rejects bad signatures and stale timestamps", async () => {
    const key = await newUser();
    const source = await resendSource(key);
    const other = "whsec_" + Buffer.from("some-other-key").toString("base64");
    expect((await sendResend(source.userId, email("email.bounced"), { secret: other })).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect((await sendResend(source.userId, email("email.bounced"), { timestamp: stale })).status).toBe(401);
    expect(await readAll(key)).toHaveLength(0);
  });

  it("accepts events that aren't about an email", async () => {
    const key = await newUser();
    const source = await resendSource(key);
    const domain = { type: "domain.updated", created_at: "2026-10-15T12:00:00.000Z", data: { id: "dom_1" } };
    expect((await sendResend(source.userId, domain)).status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.event).toMatchObject({ source: "https://api.resend.com", subject: "dom_1" });
  });

  it("dedupes redeliveries", async () => {
    const key = await newUser();
    const source = await resendSource(key);
    expect((await sendResend(source.userId, email(), { id: "same" })).status).toBe(202);
    const dup = await sendResend(source.userId, email(), { id: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
  });
});
