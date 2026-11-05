import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newSource, newUser, readAll } from "../helpers.js";

describe("linear webhooks", () => {
  const SECRET = "linear-made-this-secret";

  const linearSource = (key: string, secret?: string) => newSource(key, { type: "linear", secret });

  function sendLinear(userId: string, body: unknown, delivery: string = randomUUID(), secret = SECRET) {
    const raw = JSON.stringify(body);
    return app.request(`/api/webhooks/${userId}`, {
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
    const source = await linearSource(key);
    expect(source).toMatchObject({ secret_set: false });
    const early = await sendLinear(source.userId, issue("create"));
    expect(early.status).toBe(401);
    expect((await early.json()).error.code).toBe("unverified");
    await call("PATCH", `/sources/${source.id}`, { key, body: { secret: SECRET } });
    expect((await sendLinear(source.userId, issue("create"))).status).toBe(202);
  });

  it("stores events as CloudEvents, with a comment's subject being its issue", async () => {
    const key = await newUser();
    const source = await linearSource(key, SECRET);
    const body = issue("create");
    expect((await sendLinear(source.userId, body, "d_1")).status).toBe(202);
    const comment = { ...issue("create"), type: "Comment", data: { id: "c_1", issueId: "iss_1", body: "yo" } };
    expect((await sendLinear(source.userId, comment, "d_2")).status).toBe(202);
    const events = (await readAll(key)).map((m) => m.event);
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

  it("refuses a delivery whose signed timestamp is old, so a captured one can't be replayed", async () => {
    const key = await newUser();
    const source = await newSource(key, { type: "linear", secret: SECRET });
    const body = (webhookTimestamp: number) => ({
      type: "Issue",
      action: "create",
      data: { id: "i" },
      webhookTimestamp,
    });
    expect((await sendLinear(source.userId, body(Date.now()))).status).toBe(202);
    expect((await sendLinear(source.userId, body(Date.now() - 3_600_000))).status).toBe(401);
  });

  it("rejects bad signatures and dedupes redeliveries", async () => {
    const key = await newUser();
    const source = await linearSource(key, SECRET);
    expect((await sendLinear(source.userId, issue("create"), "d_x", "wrong")).status).toBe(401);
    expect((await sendLinear(source.userId, issue("create"), "same")).status).toBe(202);
    const dup = await sendLinear(source.userId, issue("create"), "same");
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    expect(await readAll(key)).toHaveLength(1);
  });
});
