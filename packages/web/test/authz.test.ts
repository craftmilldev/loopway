import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newSource, newUser, prPayload, sendGithub } from "./helpers.js";

// Every route is either listed as public here or answers 401 without a token, and every route that names something of a
// user's answers 404 for anyone else, leaving it as it was.

// Public on purpose: the page, health, signed webhooks, login.
const PUBLIC = [
  /^GET \/api\/?$/,
  /^GET \/api\/health$/,
  /^POST \/api\/webhooks\/:userId$/,
  /^POST \/api\/auth\/(login|verify)$/,
  // The page, its bundle, llms.txt and install.sh (GETs that serve no account data).
  /^GET \/(app\.js|app\.css|llms\.txt|install\.sh)?$/,
  // The database middleware, which runs for every request and answers nothing itself.
  /^ALL \/\*$/,
];

describe("authentication", () => {
  it("covers every API route that isn't public", async () => {
    const routes = [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].filter(
      (r) => !PUBLIC.some((p) => p.test(r)),
    );
    let checked = 0;
    for (const route of routes) {
      const [method, path] = route.split(" ") as [string, string];
      const res = await app.request(path.replace(/:\w+/g, randomUUID()), { method });
      expect(res.status, route).toBe(401);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("ownership", () => {
  it("keeps one user's sources, messages and tokens from another", async () => {
    const owner = await newUser("owner");
    const stranger = await newUser("stranger");
    const source = await newSource(owner);
    const sent = await sendGithub(source, "pull_request", prPayload(1));
    expect(sent.status).toBe(202);
    const { id: message } = (await sent.json()) as { id: string };
    const token = (await call("POST", "/tokens", { key: owner, body: { name: "t" } })).body as { id: string };

    for (const [method, path, body] of [
      ["GET", `/sources/${source.id}`],
      ["PATCH", `/sources/${source.id}`, { name: "taken" }],
      ["DELETE", `/sources/${source.id}`],
      ["GET", `/messages/${message}`],
      ["DELETE", `/tokens/${token.id}`],
    ] as const) {
      expect((await call(method, path, { key: stranger, body })).status, `${method} ${path}`).toBe(404);
    }

    expect((await call("GET", `/messages/${message}`, { key: owner })).status).toBe(200);
    const after = await call("GET", `/sources/${source.id}`, { key: owner });
    expect(after.body).toMatchObject({ name: "github" });
    expect((await call("GET", "/sources", { key: stranger })).body.data).toEqual([]);
    expect((await call("GET", "/tokens", { key: stranger })).body.data).toEqual([]);
    expect((await call("GET", "/messages?since=0", { key: stranger })).body.data).toEqual([]);
    expect((await call("GET", "/messages?order=desc", { key: stranger })).body.data).toEqual([]);
    expect((await call("GET", "/inbox", { key: stranger })).body).toMatchObject({ sources: 0, messages: 0 });
  });
});
