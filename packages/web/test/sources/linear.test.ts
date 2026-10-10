import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newUser } from "../helpers.js";

describe("linear webhooks", () => {
  const SECRET = "linear-made-this-secret";

  async function linearInbox(key: string, config?: unknown) {
    const r = await call("POST", "/inboxes", { key, body: { name: "ln", source_type: "linear", config } });
    expect(r.status).toBe(201);
    return r.body as {
      id: string;
      config: { secret: string | null; events: string[] };
      setup: Record<string, unknown>;
    };
  }

  function sendLinear(inboxId: string, body: unknown, delivery: string = randomUUID(), secret = SECRET) {
    const raw = JSON.stringify(body);
    return app.request(`/webhooks/${inboxId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": delivery,
        "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
      },
      body: raw,
    });
  }

  const issue = (action: string) => ({
    action,
    type: "Issue",
    createdAt: "2026-10-10T00:00:00.000Z",
    organizationId: "org_1",
    url: "https://linear.app/acme/issue/ENG-1",
    data: { id: "iss_1", identifier: "ENG-1", title: "Hi" },
  });

  it("rejects deliveries until a secret is set", async () => {
    const key = await newUser();
    const inbox = await linearInbox(key);
    expect(inbox.config).toEqual({ secret: null, events: ["*"] });
    expect((await sendLinear(inbox.id, issue("create"))).status).toBe(401);
    await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: SECRET } } });
    expect((await sendLinear(inbox.id, issue("create"))).status).toBe(202);
  });

  it("stores events as CloudEvents, with a comment's subject being its issue", async () => {
    const key = await newUser();
    const inbox = await linearInbox(key, { secret: SECRET });
    const body = issue("create");
    expect((await sendLinear(inbox.id, body, "d_1")).status).toBe(202);
    const comment = { ...issue("create"), type: "Comment", data: { id: "c_1", issueId: "iss_1", body: "yo" } };
    expect((await sendLinear(inbox.id, comment, "d_2")).status).toBe(202);
    const msgs = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data;
    const events = msgs.map((m: { event: unknown }) => m.event);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: "d_1",
        type: "com.linear.issue.create",
        source: "https://linear.app/org_1",
        subject: "iss_1",
        time: "2026-10-10T00:00:00.000Z",
        data: body,
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "com.linear.comment.create", subject: "iss_1" }));
  });

  it("rejects bad signatures, dedupes redeliveries, and filters events", async () => {
    const key = await newUser();
    const inbox = await linearInbox(key, { secret: SECRET, events: ["Issue.create"] });
    expect(inbox.config.events).toEqual(["issue.create"]);
    expect((await sendLinear(inbox.id, issue("create"), "d_x", "wrong")).status).toBe(401);
    expect((await sendLinear(inbox.id, issue("create"), "same")).status).toBe(202);
    const dup = await sendLinear(inbox.id, issue("create"), "same");
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    const filtered = await sendLinear(inbox.id, issue("remove"));
    expect(filtered.status).toBe(422);
    expect((await filtered.json()).error.message).toBe('event "issue.remove" not enabled for this inbox');
  });
});
