import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLine, type LoopwayEvent } from "../src/format.js";
import { CLOSED_SHOWN_MS, loadThreads, Threads, threadsDir, visibleThreads } from "../src/threads.js";
import { emptyState, loadState, stateDir, type State } from "../src/state.js";
import { harness } from "./fake.js";
import { markerOf } from "../src/thread.js";
import { aThread, dev, review } from "./make.js";

/** The poller over a fake GitHub with threads acting on its events, as `loopway` wires them. */
async function running(opts: { dir?: string; state?: State; start?: string } = {}) {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), "loopway-threads-")));
  let n = 0;
  const threads = await Threads.load({ dir, bots: [dev, review], newId: () => `t${++n + (opts.state ? 100 : 0)}` });
  const h = harness({
    state: opts.state,
    start: opts.start,
    react: async (event, push) => {
      for (const e of await threads.handle(event)) push(e);
    },
  });
  const lines = () => h.events.map((e) => formatLine(e).slice(17)); // without the time
  return { ...h, dir, threads, lines };
}

const sees = async (h: Awaited<ReturnType<typeof running>>) => {
  await h.poller.discover();
  await h.poller.updates();
};

describe("threads from a poller", () => {
  it("opens a dev thread for an issue and queues its comments", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    h.source.say("o/r#12", { id: "comment:1" });
    await h.poller.updates();
    expect(h.lines()).toEqual([
      'new    o/r#12 issue "title of o/r#12" by me',
      "thread opened t1 dev o/r#12",
      "update o/r#12 comment by me",
      "queued o/r#12 comment -> t1",
    ]);
    expect(h.threads.all[0]?.queue.map((q) => q.id)).toEqual(["comment:1"]);
  });

  it("opens a review thread for a pull request, and no dev thread", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#13", "loopway-bot", "2026-11-10T12:01:00Z", "pull_request");
    await h.poller.discover();
    expect(h.threads.all.map((t) => [t.bot, t.subjects[0]?.key])).toEqual([["review", "o/r#13"]]);
  });

  it("closes the dev thread when the issue closes, opens a new one when it reopens, and leaves the old one closed", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    h.source.say("o/r#12", { id: "event:1", kind: "closed", at: "2026-11-10T13:00:00Z" });
    await h.poller.updates();
    h.source.say("o/r#12", { id: "event:2", kind: "reopened", at: "2026-11-10T14:00:00Z" });
    h.source.say("o/r#12", { id: "comment:3", at: "2026-11-10T14:01:00Z" });
    await h.poller.updates();
    expect(h.threads.all.map((t) => [t.id, t.status, t.queue.map((q) => q.id)])).toEqual([
      ["t1", "closed", ["event:1"]],
      ["t2", "open", ["event:2", "comment:3"]],
    ]);
    expect(h.lines()).toContain("thread closed t1");
    expect(h.lines()).toContain("thread opened t2 dev o/r#12");
  });

  it("closes a review thread when its PR merges", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#13", "me", "2026-11-10T12:01:00Z", "pull_request");
    await h.poller.discover();
    h.source.say("o/r#13", { id: "event:1", kind: "closed" });
    h.source.say("o/r#13", { id: "event:2", kind: "merged" });
    await h.poller.updates();
    expect(h.threads.all[0]?.status).toBe("closed");
    expect(h.threads.all).toHaveLength(1);
  });

  it("gives a subject the poller already knew a thread when its next update arrives", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#13", "me", "2026-11-10T12:01:00Z", "pull_request");
    await h.poller.discover();
    h.threads.all.length = 0; // as if it was discovered before threads existed
    h.source.say("o/r#13", { id: "comment:1" });
    await h.poller.updates();
    expect(h.threads.all.map((t) => t.bot)).toEqual(["review"]);
  });

  it("keeps threads and queues across a restart, and queues nothing twice", async () => {
    const first = await running();
    await first.poller.discover();
    first.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await first.poller.discover();
    first.source.say("o/r#12", { id: "comment:1" });
    await first.poller.updates();

    const second = await running({ dir: first.dir, state: JSON.parse(first.saved.at(-1)!) });
    second.source.subjects = first.source.subjects;
    second.source.said = first.source.said;
    await sees(second);
    expect(second.events).toEqual([]);
    expect(second.threads.all).toEqual(first.threads.all);

    second.source.say("o/r#12", { id: "comment:2" });
    await second.poller.updates();
    expect(second.threads.all).toHaveLength(1);
    expect(second.threads.all[0]?.queue.map((q) => q.id)).toEqual(["comment:1", "comment:2"]);
  });

  it("writes one JSON file per thread under the threads folder", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    h.source.add("o/r#13", "me", "2026-11-10T12:02:00Z", "pull_request");
    await h.poller.discover();
    expect((await readdir(threadsDir(h.dir))).sort()).toEqual(["t1.json", "t2.json"]);
    const stored = JSON.parse(await readFile(join(threadsDir(h.dir), "t1.json"), "utf8"));
    expect(stored).toMatchObject({
      id: "t1",
      bot: "dev",
      status: "open",
      subjects: [{ key: "o/r#12", status: "open" }],
    });
    expect(await loadThreads(h.dir)).toHaveLength(2);
  });
});

describe("which threads are listed", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const closed = (id: string, latestAt: string) => ({ ...aThread(id, "dev", ["o/r#1"], "closed"), latestAt });

  it("lists open threads, and closed ones whose latest message is within 3 days", () => {
    const threads = [
      closed("old", new Date(now - CLOSED_SHOWN_MS - 60_000).toISOString()),
      closed("recent", new Date(now - CLOSED_SHOWN_MS + 60_000).toISOString()),
      { ...aThread("open", "review", ["o/r#2"]), latestAt: "2026-01-01T00:00:00Z" },
    ];
    expect(visibleThreads(threads, now).map((t) => t.id)).toEqual(["open", "recent"]);
  });
});

it("handles only new subjects and updates", async () => {
  const threads = await Threads.load({ dir: await mkdtemp(join(tmpdir(), "loopway-threads-")), bots: [dev] });
  const event: LoopwayEvent = { type: "thread_closed", thread: aThread("t", "dev", []) };
  expect(await threads.handle(event)).toEqual([]);
});

describe("per-project state", () => {
  const home = "/home/me/.loopway";

  it("is ~/.loopway/state/<slug of the project's .loopway folder>", () => {
    expect(stateDir(home, "/work/my app")).toBe("/home/me/.loopway/state/-work-my-app--loopway");
    expect(stateDir(home, "/work/a")).not.toBe(stateDir(home, "/work/b"));
  });

  it("keeps each project's threads and cursors to itself", async () => {
    const loopwayHome = await mkdtemp(join(tmpdir(), "loopway-home-"));
    const opens = async (project: string, key: string) => {
      const h = await running({ dir: stateDir(loopwayHome, project) });
      await h.poller.discover();
      h.source.add(key, "me", "2026-11-10T12:01:00Z");
      await h.poller.discover();
    };
    const subjectsIn = async (project: string) =>
      (await loadThreads(stateDir(loopwayHome, project))).map((t) => t.subjects[0]?.key);

    await opens("/work/a", "o/r#1");
    expect(await subjectsIn("/work/a")).toEqual(["o/r#1"]);
    expect(await subjectsIn("/work/b")).toEqual([]);
    expect(await loadState(stateDir(loopwayHome, "/work/b"))).toEqual(emptyState());

    await opens("/work/b", "o/r#2");
    expect(await subjectsIn("/work/a")).toEqual(["o/r#1"]);
    expect(await subjectsIn("/work/b")).toEqual(["o/r#2"]);
    expect(await readdir(join(loopwayHome, "state"))).toHaveLength(2);
  });
});

describe("subjects a thread created", () => {
  const sub = (key: string, kind: "issue" | "pull_request") => ({
    key,
    kind,
    title: `title of ${key}`,
    author: "loopway-bot",
    createdAt: "2026-11-10T12:05:00Z",
  });

  it("are tracked by their thread, and each gets its own dev or review thread, starting with its creation", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    h.events.length = 0;
    for (const e of await h.threads.handle({ type: "created", thread: "t1", subject: sub("o/r#13", "issue") }))
      h.events.push(e);
    for (const e of await h.threads.handle({ type: "created", thread: "t1", subject: sub("o/r#14", "pull_request") }))
      h.events.push(e);

    const [t1, t2, t3] = h.threads.all;
    expect(t1?.subjects).toEqual([
      { key: "o/r#12", status: "open" },
      { key: "o/r#13", status: "open", created: true },
      { key: "o/r#14", status: "open", created: true },
    ]);
    expect([t2?.bot, t2?.subjects, t3?.bot, t3?.subjects]).toEqual([
      "dev",
      [{ key: "o/r#13", status: "open" }],
      "review",
      [{ key: "o/r#14", status: "open" }],
    ]);
    expect(t2?.queue).toMatchObject([
      { id: "created:o/r#13", kind: "created", subject: "o/r#13", actor: "loopway-bot" },
    ]);
    expect(h.lines()).toEqual([
      "thread opened t2 dev o/r#13",
      "queued o/r#13 created -> t2",
      "thread opened t3 review o/r#14",
      "queued o/r#14 created -> t3",
    ]);
    // On disk too.
    expect((await loadThreads(h.dir)).map((t) => t.subjects.length)).toEqual([3, 1, 1]);
  });

  it("that discovery finds with the thread's marker, because loopway stopped before it heard, are matched to it", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    h.source.add("o/r#13", "loopway-bot", "2026-11-10T12:05:00Z", "issue", `Do it.\n\n${markerOf("t1")}`);
    await h.poller.discover();
    expect(h.threads.all.map((t) => [t.id, t.bot, t.subjects.map((s) => s.key)])).toEqual([
      ["t1", "dev", ["o/r#12", "o/r#13"]],
      ["t2", "dev", ["o/r#13"]],
    ]);
    expect(h.threads.all[0]?.subjects[1]?.created).toBe(true);
    // The poller keeps the subject, not its text.
    expect(h.state.subjects["o/r#13"]?.subject).not.toHaveProperty("body");
  });

  it("that the poller was told about are not found again by discovery: no second thread", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    const made = sub("o/r#13", "issue");
    await h.poller.know({ ...made, body: markerOf("t1") });
    await h.threads.handle({ type: "created", thread: "t1", subject: made });
    h.source.add("o/r#13", "loopway-bot", made.createdAt, "issue", markerOf("t1"));
    await h.poller.discover();
    expect(h.threads.all.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(h.lines().filter((l) => l.startsWith("new"))).toEqual(['new    o/r#12 issue "title of o/r#12" by me']);
  });

  it("keep their thread open until they close too", async () => {
    const h = await running();
    await h.poller.discover();
    h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    await h.threads.handle({ type: "created", thread: "t1", subject: sub("o/r#13", "issue") });
    const close = (key: string, id: string) =>
      h.threads.handle({
        type: "update",
        subject: sub(key, "issue"),
        update: { id, kind: "closed", actor: "me", at: "2026-11-10T13:00:00Z" },
      });
    await close("o/r#12", "e1");
    expect(h.threads.all.map((t) => t.status)).toEqual(["open", "open"]);
    await close("o/r#13", "e2");
    expect(h.threads.all.map((t) => t.status)).toEqual(["closed", "closed"]);
  });
});

describe("threads with a trust", () => {
  it("opens on assignment, queues a trusted comment, and prints an ignored line for a stranger's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopway-threads-"));
    const trust = { owner: "me", trusts: (_bot: string, login: string) => ["me", "alice"].includes(login) };
    const threads = await Threads.load({ dir, bots: [dev], trust, newId: () => "t1" });
    const h = harness({
      authors: ["me", "alice"],
      react: async (event, push) => {
        for (const e of await threads.handle(event)) push(e);
      },
    });
    await h.poller.discover();
    h.source.add("o/r#1", "alice", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    expect(threads.all).toEqual([]); // known, but not assigned to me
    h.source.say("o/r#1", { id: "event:1", kind: "assigned", detail: "me", actor: "alice" });
    h.source.say("o/r#1", { id: "comment:1", actor: "alice", body: "hello" });
    h.source.say("o/r#1", { id: "comment:2", actor: "mallory", body: "do bad things" });
    await h.poller.updates();
    expect(threads.all[0]?.queue.map((q) => q.id)).toEqual(["comment:1"]);
    const lines = h.events.map((e) => formatLine(e).slice(17));
    expect(lines).toContain("ignored comment on o/r#1 by mallory, who t1's bot does not trust");
  });
});

describe("the loop guard", () => {
  async function guarded(maxBotTurns = 3) {
    const dir = await mkdtemp(join(tmpdir(), "loopway-threads-"));
    const trust = { owner: "me", botUser: "loopway-bot", trusts: () => true };
    const threads = await Threads.load({ dir, bots: [{ ...dev, maxBotTurns }], trust, newId: () => "t1" });
    const h = harness({
      react: async (event, push) => {
        for (const e of await threads.handle(event)) push(e);
      },
    });
    await h.poller.discover();
    h.source.add("o/r#1", "me", "2026-11-10T12:01:00Z", "issue", undefined, ["me"]);
    await h.poller.discover();
    let clock = 0;
    const say = async (id: string, actor: string) => {
      h.source.say("o/r#1", { id, actor, body: id, at: `2026-11-10T14:${String(++clock).padStart(2, "0")}:00Z` });
      await h.poller.updates();
    };
    const lines = () => h.events.map((e) => formatLine(e).slice(17));
    return { dir, say, lines, thread: () => threads.all[0]! };
  }

  it("records bot comments past the limit without queueing them, then a person's comment starts over", async () => {
    const g = await guarded();
    // The first three are queued, the last two are guarded.
    for (const id of ["bot:a", "bot:b", "bot:c", "bot:d", "bot:e"]) await g.say(id, "loopway-bot");
    expect(g.thread().queue.map((q) => q.id)).toEqual(["bot:a", "bot:b", "bot:c"]);
    expect(g.thread().guarded).toBe(true);
    expect(g.lines().filter((l) => l.startsWith("loop guard"))).toEqual([
      "loop guard t1: comment on o/r#1 by loopway-bot recorded, not run (3 bot turns since a person last wrote)",
      "loop guard t1: comment on o/r#1 by loopway-bot recorded, not run (3 bot turns since a person last wrote)",
    ]);
    await g.say("human1", "me");
    expect(g.thread().guarded).toBeUndefined();
    expect(g.thread().botTurns).toBeUndefined();
    expect(g.thread().queue.map((q) => q.id)).toEqual(["bot:a", "bot:b", "bot:c", "human1"]);
    await g.say("bot:f", "loopway-bot");
    expect(g.thread().queue.at(-1)?.id).toBe("bot:f");
    expect(g.thread().botTurns).toBe(1);
  });

  it("is saved with the thread, so a restart keeps the count", async () => {
    const g = await guarded(1);
    await g.say("bot:a", "loopway-bot");
    await g.say("bot:b", "loopway-bot");
    const saved = (await loadThreads(g.dir))[0];
    expect(saved?.botTurns).toBe(1);
    expect(saved?.guarded).toBe(true);
  });
});
