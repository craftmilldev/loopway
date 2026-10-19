import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api.js";
import { parseOrgFlag } from "../src/flags.js";
import { db, SECRET, call, newUser } from "./helpers.js";

describe("parseOrgFlag", () => {
  it("is off unless the variable says otherwise", () => {
    for (const unset of [undefined, "", " , "]) expect(parseOrgFlag(unset)("acme")).toBe(false);
  });

  it("turns on for every org, or for the ones named (any case)", () => {
    for (const all of ["all", "true", "1", "acme,all"]) expect(parseOrgFlag(all)("whoever")).toBe(true);
    const some = parseOrgFlag("Acme, bob");
    expect([some("acme"), some("BOB"), some("carol")]).toEqual([true, true, false]);
  });
});

describe("first-bot-by-chat off (the default)", () => {
  // The helpers' app has it on for everyone; this one is built the way a deploy without FIRST_BOT_BY_CHAT is.
  const request = (
    opts: Partial<Parameters<typeof createApi>[0]> | undefined,
    key: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    createApi({ getDb: async () => db, tokenSecret: SECRET, ...opts }).request("/api" + path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("makes no setup bot, whether the org is made or the endpoints are called", async () => {
    const key = await newUser();
    const org = (await call("GET", "/orgs", { key })).body.data[0].slug as string;
    const metrics = { capture: vi.fn(async () => {}) };
    const put = await request({ getDb: async () => db, tokenSecret: SECRET, metrics }, key, "PUT", "/setup-bot", {
      org,
      harness: "claude",
    });
    expect(put.status).toBe(404);
    const msg = await request(
      { getDb: async () => db, tokenSecret: SECRET, metrics },
      key,
      "POST",
      "/setup-bot/messages",
      {
        org,
        text: "hi",
      },
    );
    expect(msg.status).toBe(404);
    expect(metrics.capture).toHaveBeenCalledWith("first_bot_by_chat_blocked", expect.any(String), {
      endpoint: "put_setup_bot",
    });
    expect(metrics.capture).toHaveBeenCalledWith("first_bot_by_chat_blocked", expect.any(String), {
      endpoint: "post_setup_message",
    });
    await call("POST", "/orgs", { key, body: { slug: `flag-off-${Date.now()}` } });
    expect((await call("GET", `/bots?org=${org}&hidden=include`, { key })).body.data).toEqual([]);
    const orgs = await (await request(undefined, key, "GET", "/orgs")).json();
    expect(orgs.data.every((o: { first_bot_by_chat: boolean }) => o.first_bot_by_chat === false)).toBe(true);
  });

  it("is on for just the orgs named", async () => {
    const key = await newUser();
    const [mine] = (await call("GET", "/orgs", { key })).body.data;
    const flag = { firstBotByChat: parseOrgFlag(mine.slug) };
    const orgs = await (await request(flag, key, "GET", "/orgs")).json();
    expect(orgs.data.map((o: { first_bot_by_chat: boolean }) => o.first_bot_by_chat)).toEqual([true]);
    const put = await request(flag, key, "PUT", "/setup-bot", { org: mine.slug, harness: "claude" });
    expect(put.status).toBe(201);
  });
});
