import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, newInbox, newUser, prPayload, sendGithub } from "./helpers.js";

const human = { login: "alice", type: "User" };
const bot = { login: "vercel[bot]", type: "Bot" };
const comment = (n: number, sender: object, body = "hi") => ({
  action: "created",
  issue: { number: n },
  comment: { body, updated_at: "2026-10-01T12:00:00Z" },
  sender,
  repository: { url: "https://api.github.com/repos/craftmill/loopway" },
});

describe("thread automation level", () => {
  it("is 2 if a person started the thread, 3 if a bot did and a person joined, 4 if no person did", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot_ = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;

    const send = async (event: string, payload: object) => {
      await sendGithub(inbox, event, payload, { delivery: randomUUID() });
      const all = (await call("GET", `/inboxes/${inbox.id}/messages?order=desc&limit=1`, { key })).body.data;
      return all[0].id as string;
    };
    const assign = async (threadId: string, ids: string[]) => {
      const lease = (await call("POST", `/bots/${bot_.id}/lease`, { key, body: { ttl_seconds: 60 } })).body.lease.token;
      await call("POST", `/bots/${bot_.id}/assign`, {
        key,
        body: { lease_token: lease, cursor: 0, assignments: ids.map((m) => ({ message_id: m, thread_id: threadId })) },
      });
      await call("POST", `/bots/${bot_.id}/release`, { key, body: { lease_token: lease } });
      return (await call("GET", `/bots/${bot_.id}/threads/${threadId}`, { key })).body.automation_level;
    };

    const byHuman = randomUUID();
    expect(await assign(byHuman, [await send("issue_comment", comment(1, human))])).toBe(2);
    // A later bot message doesn't change who started it.
    expect(await assign(byHuman, [await send("issue_comment", comment(1, bot))])).toBe(2);

    const botThenHuman = randomUUID();
    expect(await assign(botThenHuman, [await send("issue_comment", comment(2, bot))])).toBe(4);
    expect(await assign(botThenHuman, [await send("issue_comment", comment(2, human))])).toBe(3);

    // The review bot posts as a person's login, but its body says it's the bot.
    const review = randomUUID();
    expect(
      await assign(review, [await send("issue_comment", comment(3, human, "Nothing.\n<!-- loopway-review -->"))]),
    ).toBe(4);

    // No sender, so no known author.
    const unknown = randomUUID();
    expect(await assign(unknown, [await send("pull_request", prPayload(4))])).toBeNull();
  });
});
