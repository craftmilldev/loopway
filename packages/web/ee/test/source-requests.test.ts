import { describe, expect, it } from "vitest";
import { createApi } from "../../src/api.js";
import { createUser } from "../../src/store.js";
import { signSessionToken } from "../../src/tokens.js";
import { app, call, db, newUser, SECRET } from "../../test/helpers.js";

describe("source requests", () => {
  // Sends the requests app's fetches to the test app.
  const viaApp: typeof fetch = async (url, init) => app.request(url, init);

  // A deployment whose source requests go to a loopway inbox on the test app.
  async function requestsApp() {
    const owner = await newUser("Craftmill");
    const r = await call("POST", "/inboxes", { key: owner, body: { name: "source-requests", source_type: "loopway" } });
    const inbox = r.body as { id: string; webhook_url: string; config: { secret: string } };
    const a = createApi({
      getDb: async () => db,
      tokenSecret: SECRET,
      sourceRequests: { url: inbox.webhook_url, token: inbox.config.secret },
      fetch: viaApp,
    });
    const post = (key: string, body: unknown) =>
      a.request("/api/sources/requests", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { a, owner, inbox, post };
  }

  it("posts a source.requested message to the requests inbox", async () => {
    const { a, owner, inbox, post } = await requestsApp();
    const { user } = await createUser(db, { name: "Asker", email: "asker@example.com" });
    const key = signSessionToken(user.id, SECRET).token;

    const sources = await a.request("/api/sources", { headers: { authorization: `Bearer ${key}` } });
    expect((await sources.json()).can_request).toBe(true);

    const res = await post(key, { description: "  Linear, https://linear.app/developers/webhooks " });
    expect(res.status).toBe(202);
    const messages = await call("GET", `/inboxes/${inbox.id}/messages`, { key: owner });
    expect(messages.body.data).toHaveLength(1);
    expect(messages.body.data[0].event.data.user).toEqual({ id: user.id });
    expect(messages.body.data[0].event).toMatchObject({
      type: "source.requested",
      data: {
        description: "Linear, https://linear.app/developers/webhooks",
        user: { id: user.id },
      },
    });

    expect((await post(key, { description: " " })).status).toBe(400);
  });

  it("is off unless the deployment sets a requests inbox", async () => {
    const key = await newUser();
    expect((await call("GET", "/sources", { key })).body.can_request).toBe(false);
    expect((await call("POST", "/sources/requests", { key, body: { description: "Linear" } })).status).toBe(404);
  });

  it("answers 502 when the requests inbox refuses the message", async () => {
    const broken = createApi({
      getDb: async () => db,
      tokenSecret: SECRET,
      sourceRequests: { url: "https://loopway.test/api/webhooks/nope", token: "wrong" },
      fetch: viaApp,
    });
    const key = await newUser();
    const res = await broken.request("/api/sources/requests", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "Linear" }),
    });
    expect(res.status).toBe(502);
  });

  it("posts a harness.requested message with the product page's url", async () => {
    const { owner, inbox, a } = await requestsApp();
    const key = await newUser();
    const post = (body: unknown) =>
      a.request("/api/harnesses/requests", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post({ url: "https://example.com/product" })).status).toBe(202);
    expect((await post({ url: "not a url" })).status).toBe(400);
    expect((await post({ url: "javascript:alert(1)" })).status).toBe(400);

    const messages = await call("GET", `/inboxes/${inbox.id}/messages`, { key: owner });
    expect(messages.body.data).toHaveLength(1);
    expect(messages.body.data[0].event).toMatchObject({
      type: "harness.requested",
      data: { url: "https://example.com/product" },
    });
  });

  it("lists harnesses and defaults a new bot to Claude Code", async () => {
    const key = await newUser();
    const list = await call("GET", "/harnesses", { key });
    expect(list.body.data).toEqual([{ id: "claude-code", label: "Claude Code" }]);
    expect(list.body.can_request).toBe(false);
    expect((await call("POST", "/harnesses/requests", { key, body: { url: "https://example.com" } })).status).toBe(404);
  });
});
