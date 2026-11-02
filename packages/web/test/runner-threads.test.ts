import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, newInbox, newUser, prPayload, sendGithub, settled } from "./helpers.js";

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

async function runner(key: string, name = "laptop") {
  const id = randomUUID();
  await call("POST", "/runners", { key, body: { id, name } });
  const token = (await call("POST", `/runners/${id}/lease`, { key, body: {} })).body.lease.token as string;
  const board = (bots: string[], since?: string) =>
    call("GET", `/runners/${id}/threads?bots=${bots.join(",")}${since ? `&since=${encodeURIComponent(since)}` : ""}`, {
      key,
    });
  return { id, token, board };
}

describe("runner dashboard threads", () => {
  it("shows each thread's row as the dashboard needs it, and the org's runners", async () => {
    const key = await newUser();
    const a = await bot(key);
    const r = await runner(key);
    const other = await runner(key, "desktop");
    const titled = prPayload(1);
    await sendGithub(a.inbox, "pull_request", { ...titled, pull_request: { ...titled.pull_request, title: "Fix it" } });
    await sendGithub(a.inbox, "pull_request", prPayload(2));
    await settled();
    const listed = (await r.board([a.id])).body.data as { id: string; subjects: string[] }[];
    const t1 = listed.find((t) => t.subjects[0] === "pr-1");
    const t2 = listed.find((t) => t.subjects[0] === "pr-2");
    await call("POST", `/bots/${a.id}/threads/${t1!.id}/claim`, { key, body: { lease_token: r.token } });
    await call("POST", `/bots/${a.id}/threads/${t2!.id}/claim`, { key, body: { lease_token: other.token } });

    const res = await r.board([a.id]);
    expect(res.status).toBe(200);
    const mine = res.body.data.find((t: { id: string }) => t.id === t1!.id);
    const theirs = res.body.data.find((t: { id: string }) => t.id === t2!.id);
    expect(Object.keys(mine).sort()).toEqual(
      [
        "automation_level",
        "bot_id",
        "id",
        "interrupted",
        "limited",
        "runner_id",
        "status",
        "subjects",
        "title",
        "updated_at",
        "waiting",
      ].sort(),
    );
    expect(mine).toMatchObject({ id: t1!.id, runner_id: r.id, subjects: ["pr-1"], status: "active" });
    expect(mine.title).toBe("Fix it");
    expect(mine.waiting).toEqual([{ id: expect.any(String), type: expect.any(String), subject: "pr-1" }]);
    // Another runner's waiting messages aren't this dashboard's to show.
    expect(theirs).toMatchObject({ id: t2!.id, runner_id: other.id, waiting: [], title: null });
    expect(res.body.runners).toEqual([
      { id: r.id, name: "laptop", leased: true },
      { id: other.id, name: "desktop", leased: true },
    ]);
    expect(res.body.as_of).toEqual(expect.any(String));
  });

  it("with since, shows only the threads that changed after it", async () => {
    const key = await newUser();
    const a = await bot(key);
    const r = await runner(key);
    await sendGithub(a.inbox, "pull_request", prPayload(1));
    await sendGithub(a.inbox, "pull_request", prPayload(2));
    await settled();
    const first = await r.board([a.id]);
    expect(first.body.data).toHaveLength(2);
    const after = new Date(Date.now() + 1000).toISOString();
    expect((await r.board([a.id], after)).body.data).toEqual([]);

    // Moments later, a new message for PR 2 changes its thread only.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await sendGithub(a.inbox, "pull_request", { ...prPayload(2), action: "synchronize" });
    await settled();
    const changed = (await r.board([a.id], after)).body.data as { subjects: string[] }[];
    expect(changed.map((t) => t.subjects)).toEqual([["pr-2"]]);
  });

  it("shows nothing of another org's bot, and refuses a bad query", async () => {
    const key = await newUser();
    const stranger = await newUser("Someone");
    const theirs = await bot(stranger);
    const r = await runner(key);
    await sendGithub(theirs.inbox, "pull_request", prPayload(1));
    await settled();
    expect((await r.board([theirs.id])).body.data).toEqual([]);
    expect((await r.board(["nope"])).status).toBe(400);
    expect((await r.board([theirs.id], "yesterday")).status).toBe(400);
  });
});
