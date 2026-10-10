import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, newInbox, newUser, prPayload, sendGithub } from "../helpers.js";

describe("github webhooks", () => {
  it("stores a signed event as a CloudEvent", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const res = await sendGithub(inbox, "pull_request", prPayload(7), { delivery: "d-1" });
    expect(res.status).toBe(202);
    const list = await call("GET", `/inboxes/${inbox.id}/messages`, { key });
    const e = list.body.data[0];
    expect(e.event).toMatchObject({
      specversion: "1.0",
      id: "d-1",
      type: "com.github.pull_request.opened",
      source: "https://api.github.com/repos/craftmill/loopway",
      subject: "7",
      time: "2026-10-01T12:00:00.000Z",
      datacontenttype: "application/json",
      data: prPayload(7),
    });
  });

  it("accepts form-encoded payloads", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const res = await sendGithub(inbox, "push", { ref: "refs/heads/main", repository: { url: "u" } }, { form: true });
    expect(res.status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0];
    expect(e.event.type).toBe("com.github.push");
    expect(e.event.subject).toBe("refs/heads/main");
  });

  it("rejects bad signatures and unknown inboxes", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    expect((await sendGithub(inbox, "push", {}, { secret: "x".repeat(32) })).status).toBe(401);
    expect((await sendGithub({ ...inbox, id: randomUUID() }, "push", {})).status).toBe(404);
  });

  it("dedupes redeliveries, ignores ping, rejects filtered events", async () => {
    const key = await newUser();
    const inbox = await newInbox(key, { events: ["pull_request"] });
    expect((await sendGithub(inbox, "pull_request", prPayload(1), { delivery: "same" })).status).toBe(202);
    const dup = await sendGithub(inbox, "pull_request", prPayload(1), { delivery: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    expect(await (await sendGithub(inbox, "ping", { zen: "hi" })).json()).toMatchObject({ ignored: true });
    const filtered = await sendGithub(inbox, "push", { ref: "x" });
    expect(filtered.status).toBe(422);
    expect((await filtered.json()).error.message).toBe('event "push" not enabled for this inbox');
    expect((await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data).toHaveLength(1);
  });
});
