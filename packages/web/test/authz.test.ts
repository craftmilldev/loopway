import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app, call, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

// Every route is either listed as public here or answers 401 without a token, and every route that names an inbox
// answers 404 for anyone but its owner, leaving the inbox as it was.

// Public on purpose: the page, health, signed webhooks, login.
const PUBLIC = [
  /^GET \/api\/?$/,
  /^GET \/api\/health$/,
  /^POST \/api\/webhooks\/:inboxId$/,
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
  it("keeps one user's inbox and messages from another", async () => {
    const owner = await newUser("owner");
    const stranger = await newUser("stranger");
    const inbox = await newInbox(owner);
    const sent = await sendGithub(inbox, "pull_request", prPayload(1));
    expect(sent.status).toBe(202);
    const { id: message } = (await sent.json()) as { id: string };
    const base = `/inboxes/${inbox.id}`;

    for (const [method, path, body] of [
      ["GET", base],
      ["PATCH", base, { name: "taken" }],
      ["DELETE", base],
      ["GET", `${base}/messages`],
      ["GET", `${base}/messages/${message}`],
      ["POST", `${base}/test`, {}],
    ] as const) {
      expect((await call(method, path, { key: stranger, body })).status, `${method} ${path}`).toBe(404);
    }

    expect((await call("GET", `${base}/messages/${message}`, { key: owner })).status).toBe(200);
    const after = await call("GET", base, { key: owner });
    expect(after.body).toMatchObject({ name: "gh", stats: { messages: 1 } });
    expect((await call("GET", "/inboxes", { key: stranger })).body.data).toEqual([]);
  });
});
