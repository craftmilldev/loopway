import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newSource, newUser, readAll } from "../helpers.js";

describe("vercel webhooks", () => {
  const VERCEL_SECRET = "vercel-made-this-secret";

  const vercelSource = (key: string, secret?: string) => newSource(key, { type: "vercel", secret });

  function sendVercel(userId: string, body: unknown, secret = VERCEL_SECRET) {
    const raw = JSON.stringify(body);
    return app.request(`/api/webhooks/${userId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vercel-signature": createHmac("sha1", secret).update(raw).digest("hex"),
      },
      body: raw,
    });
  }

  const deployment = (type: string, id: string = randomUUID()) => ({
    id,
    type,
    createdAt: 1790000000000,
    region: "iad1",
    payload: {
      team: { id: "team_1" },
      user: { id: "user_1" },
      deployment: { id: "dpl_1", meta: { githubPrId: "12" } },
      project: { id: "prj_1" },
    },
  });

  it("registers without a secret and rejects deliveries until one is set", async () => {
    const key = await newUser();
    const source = await vercelSource(key);
    expect(source).toMatchObject({ secret_set: false });
    const early = await sendVercel(source.userId, deployment("deployment.created"));
    expect(early.status).toBe(401);
    expect((await early.json()).error.code).toBe("unverified");

    const r = await call("PATCH", `/sources/${source.id}`, { key, body: { secret: VERCEL_SECRET } });
    expect(r.body.secret_set).toBe(true);
    expect((await sendVercel(source.userId, deployment("deployment.created"))).status).toBe(202);
  });

  it("stores a signed event as a CloudEvent with the deployment as subject", async () => {
    const key = await newUser();
    const source = await vercelSource(key, VERCEL_SECRET);
    const body = deployment("deployment.error", "evt_1");
    expect((await sendVercel(source.userId, body)).status).toBe(202);
    const [e] = await readAll(key);
    expect(e!.event).toMatchObject({
      specversion: "1.0",
      id: "evt_1",
      type: "com.vercel.deployment.error",
      source: "https://api.vercel.com/v9/projects/prj_1",
      subject: "dpl_1",
      time: new Date(1790000000000).toISOString(),
      datacontenttype: "application/json",
      data: body,
    });
  });

  it("gives every event a subject", async () => {
    const key = await newUser();
    const source = await vercelSource(key, VERCEL_SECRET);
    const cases: [type: string, payload: unknown, source: string, subject: string][] = [
      [
        "deployment.rollback",
        { project: { id: "prj_1" }, toDeploymentId: "dpl_2" },
        "https://api.vercel.com/v9/projects/prj_1",
        "dpl_2",
      ],
      [
        "project.renamed",
        { team: { id: "team_1" }, project: { id: "prj_1" } },
        "https://api.vercel.com/v9/projects/prj_1",
        "prj_1",
      ],
      [
        "project.domain.updated",
        { project: { id: "prj_1" }, previous: { domain: "a.dev" }, next: { domain: "b.dev" } },
        "https://api.vercel.com/v9/projects/prj_1",
        "a.dev",
      ],
      [
        "project.env-variable.created",
        { projectId: "prj_1", envVarId: "env_1" },
        "https://api.vercel.com/v9/projects/prj_1",
        "env_1",
      ],
      [
        "domain.created",
        { team: { id: "team_1" }, domain: { name: "a.dev" } },
        "https://api.vercel.com/v2/teams/team_1",
        "a.dev",
      ],
      [
        "flag.updated",
        { flag: { id: "flag_1", projectId: "prj_1" } },
        "https://api.vercel.com/v9/projects/prj_1",
        "flag_1",
      ],
      ["something.new", {}, "https://vercel.com", "evt_new"],
    ];
    for (const [type, payload, ceSource, subject] of cases) {
      const id = type === "something.new" ? "evt_new" : randomUUID();
      expect((await sendVercel(source.userId, { id, type, createdAt: Date.now(), payload })).status).toBe(202);
      const e = (await readAll(key)).find((m) => m.event.type === `com.vercel.${type}`);
      expect(e!.event).toMatchObject({ source: ceSource, subject });
    }
  });

  it("rejects bad signatures and dedupes redeliveries", async () => {
    const key = await newUser();
    const source = await vercelSource(key, VERCEL_SECRET);
    expect((await sendVercel(source.userId, deployment("deployment.error"), "wrong")).status).toBe(401);
    expect((await sendVercel(source.userId, deployment("deployment.error", "same"))).status).toBe(202);
    const dup = await sendVercel(source.userId, deployment("deployment.error", "same"));
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    expect(await readAll(key)).toHaveLength(1);
  });
});
