import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

type Kind = "human" | "bot" | undefined;

describe("thread automation level", () => {
  it("is 2 if a person started the thread, 4 if a bot did, and 3 once a person joins a bot's", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;

    const message = async () => {
      await sendGithub(inbox, "pull_request", prPayload(1), { delivery: randomUUID() });
      return (await call("GET", `/inboxes/${inbox.id}/messages?order=desc&limit=1`, { key })).body.data[0].id as string;
    };
    // Assigns one page of messages, each with its author kind, to the thread; returns the thread's level.
    const assign = async (threadId: string, kinds: Kind[]) => {
      const assignments = [];
      for (const author_kind of kinds)
        assignments.push({ message_id: await message(), thread_id: threadId, author_kind });
      const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
      const r = await call("POST", `/bots/${bot.id}/assign`, {
        key,
        body: { lease_token: lease, cursor: 0, assignments },
      });
      expect(r.status).toBe(200);
      await call("POST", `/bots/${bot.id}/release`, { key, body: { lease_token: lease } });
      return (await call("GET", `/bots/${bot.id}/threads/${threadId}`, { key })).body.automation_level;
    };

    // A person starts it: 2, and nothing moves it.
    const byHuman = randomUUID();
    expect(await assign(byHuman, ["human"])).toBe(2);
    expect(await assign(byHuman, ["bot"])).toBe(2);
    expect(await assign(byHuman, ["human"])).toBe(2);

    // A bot starts it: 4, and a person's message moves it to 3, where it stays.
    const byBot = randomUUID();
    expect(await assign(byBot, ["bot"])).toBe(4);
    expect(await assign(byBot, ["bot"])).toBe(4);
    expect(await assign(byBot, ["human"])).toBe(3);
    expect(await assign(byBot, ["bot"])).toBe(3);

    // The first message of a page decides, and a person later in it makes it 3.
    expect(await assign(randomUUID(), ["bot", "human"])).toBe(3);
    expect(await assign(randomUUID(), ["human", "bot"])).toBe(2);

    // No author kind, no level.
    expect(await assign(randomUUID(), [undefined])).toBeNull();

    // An author kind that isn't human or bot is refused.
    const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
    const refused = await call("POST", `/bots/${bot.id}/assign`, {
      key,
      body: {
        lease_token: lease,
        cursor: 0,
        assignments: [{ message_id: await message(), thread_id: randomUUID(), author_kind: "robot" }],
      },
    });
    expect(refused.status).toBe(400);
  });
});
