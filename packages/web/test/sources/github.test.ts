import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newSource, newUser, prPayload, readAll, sendGithub } from "../helpers.js";

describe("github webhooks", () => {
  it("stores a signed event as a CloudEvent", async () => {
    const key = await newUser();
    const source = await newSource(key);
    const res = await sendGithub(source, "pull_request", prPayload(7), { delivery: "d-1" });
    expect(res.status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.source_id).toBe(source.id);
    expect(e!.event).toMatchObject({
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
    const source = await newSource(key);
    const res = await sendGithub(source, "push", { ref: "refs/heads/main", repository: { url: "u" } }, { form: true });
    expect(res.status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.event.type).toBe("com.github.push");
    expect(e!.event.subject).toBe("refs/heads/main");
  });

  it("rejects bad signatures and unknown inboxes", async () => {
    const key = await newUser();
    const source = await newSource(key);
    const bad = await sendGithub(source, "push", {}, { secret: "x".repeat(32) });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("unverified");
    expect((await sendGithub({ ...source, userId: randomUUID() }, "push", {})).status).toBe(404);
    expect(await readAll(key)).toHaveLength(0);
  });

  it("dedupes redeliveries and ignores ping", async () => {
    const key = await newUser();
    const source = await newSource(key);
    expect((await sendGithub(source, "pull_request", prPayload(1), { delivery: "same" })).status).toBe(202);
    const dup = await sendGithub(source, "pull_request", prPayload(1), { delivery: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    expect(await (await sendGithub(source, "ping", { zen: "hi" })).json()).toMatchObject({ ignored: true });
    expect(await readAll(key)).toHaveLength(1);
  });
});
