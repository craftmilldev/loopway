import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, events, newInbox, newUser, prPayload, sendGithub, settled } from "./helpers.js";

// A message about PR n goes to the thread holding "pr-n", or a new one.
const RULES = [{ types: ["*"], subject: "'pr-' + string(data.number)", action: "'attach'" }];

async function bot(key: string, name = "b") {
  const inbox = await newInbox(key);
  const made = await call("POST", "/bots", {
    key,
    body: { name, model: "sonnet", harness: "claude", inbox_ids: [inbox.id], prompt: "p", rules: RULES },
  });
  return { inbox, id: made.body.id as string };
}

/** A registered runner with a live lease. */
async function runner(key: string, name = "laptop") {
  const id = randomUUID();
  await call("POST", "/runners", { key, body: { id, name } });
  const token = (await call("POST", `/runners/${id}/lease`, { key, body: {} })).body.lease.token as string;
  const work = (bots: string[], as = token) =>
    call("GET", `/runners/${id}/work?bots=${bots.join(",")}`, { key, headers: { "x-lease-token": as } });
  return { id, token, work };
}

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((t) => t.id).sort();

describe("runner work feed", () => {
  it("lists owned threads with waiting messages and unowned ones, for the listed bots only", async () => {
    const key = await newUser();
    const a = await bot(key, "a");
    const b = await bot(key, "b");
    const r = await runner(key);
    const other = await runner(key, "desktop");
    for (const n of [1, 2]) await sendGithub(a.inbox, "pull_request", prPayload(n));
    await sendGithub(b.inbox, "pull_request", prPayload(3));
    await settled();

    const all = await r.work([a.id, b.id]);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(3);
    expect(all.body.data.every((t: { runner_id: string | null }) => t.runner_id === null)).toBe(true);
    expect(all.body.data[0].waiting).toHaveLength(1);
    expect(await r.work([a.id])).toMatchObject({ body: { data: expect.any(Array) } });
    expect((await r.work([a.id])).body.data).toHaveLength(2);
    expect((await r.work([])).body.data).toEqual([]);

    // Once claimed, a thread is only in its owner's feed.
    const first = all.body.data[0];
    const claimed = await call("POST", `/bots/${first.bot_id}/threads/${first.id}/claim`, {
      key,
      body: { lease_token: r.token },
    });
    expect(claimed.status).toBe(200);
    expect(ids(await r.work([a.id, b.id]))).toEqual(ids(all));
    expect(ids(await other.work([a.id, b.id]))).toEqual(ids(all).filter((id) => id !== first.id));
    expect(events.some((e) => e.event === "runner_work_listed")).toBe(true);
  });

  it("includes an owned thread that needs a run, and drops one with nothing to do", async () => {
    const key = await newUser();
    const a = await bot(key);
    const r = await runner(key);
    await sendGithub(a.inbox, "pull_request", prPayload(1));
    await settled();
    const [t] = (await r.work([a.id])).body.data;
    await call("POST", `/bots/${a.id}/threads/${t.id}/claim`, { key, body: { lease_token: r.token } });
    const delivered = await call("POST", `/bots/${a.id}/threads/${t.id}/deliver`, {
      key,
      body: { lease_token: r.token },
    });
    expect(delivered.status).toBe(200);
    await call("POST", `/bots/${a.id}/threads/${t.id}/finish`, { key, body: { lease_token: r.token } });
    expect((await r.work([a.id])).body.data).toEqual([]);

    await call("PATCH", `/bots/${a.id}/threads/${t.id}`, { key, body: { lease_token: r.token, interrupted: true } });
    expect(ids(await r.work([a.id]))).toEqual([t.id]);
  });

  it("shows nothing for a bot of another org", async () => {
    const key = await newUser();
    const stranger = await newUser("Someone");
    const theirs = await bot(stranger);
    const r = await runner(key);
    await sendGithub(theirs.inbox, "pull_request", prPayload(1));
    await settled();
    expect((await r.work([theirs.id])).body.data).toEqual([]);
  });

  it("needs the runner's live lease and valid bot ids", async () => {
    const key = await newUser();
    const a = await bot(key);
    const r = await runner(key);
    const other = await runner(key, "desktop");
    expect((await r.work([a.id], "nope")).body.error.code).toBe("runner_not_leased");
    expect((await r.work([a.id], other.token)).body.error.code).toBe("runner_not_leased");
    const none = await call("GET", `/runners/${r.id}/work?bots=${a.id}`, { key });
    expect(none.body.error.code).toBe("runner_not_leased");
    expect((await r.work(["not-a-bot"])).status).toBe(400);
    expect(events.some((e) => e.event === "runner_work_rejected" && e.properties?.reason === "invalid_bots")).toBe(
      true,
    );
  });

  it("lets exactly one of two racing runners claim a thread", async () => {
    const key = await newUser();
    const a = await bot(key);
    const one = await runner(key, "one");
    const two = await runner(key, "two");
    await sendGithub(a.inbox, "pull_request", prPayload(1));
    await settled();
    const [t] = (await one.work([a.id])).body.data;
    const claim = (token: string) =>
      call("POST", `/bots/${a.id}/threads/${t.id}/claim`, { key, body: { lease_token: token } });
    const results = await Promise.all([claim(one.token), claim(two.token)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.status === 409)!.body.error.code).toBe("thread_owned");
    expect((await one.work([a.id])).body.data.length + (await two.work([a.id])).body.data.length).toBe(1);
  });
});
