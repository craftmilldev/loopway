import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLine, type LoopwayEvent } from "../src/format.js";
import { CLOSED_SHOWN_MS, loadThreads, Threads, threadsDir, visibleThreads } from "../src/threads.js";
import { emptyState, loadState, saveState, stateDir, type State } from "../src/state.js";
import { harness } from "./fake.js";
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
  const opens = async (project: string, key: string) => {
    const h = await running({ dir: stateDir(project, {}) });
    await h.poller.discover();
    h.source.add(key, "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    return h;
  };
  const subjectsIn = async (project: string) =>
    (await loadThreads(stateDir(project, {}))).map((t) => t.subjects[0]?.key);

  it("keeps each project's threads and cursors to itself", async () => {
    const a = await mkdtemp(join(tmpdir(), "loopway-a-"));
    const b = await mkdtemp(join(tmpdir(), "loopway-b-"));
    await opens(a, "o/r#1");

    expect(await subjectsIn(a)).toEqual(["o/r#1"]);
    expect(await subjectsIn(b)).toEqual([]);
    expect(await loadState(stateDir(b, {}))).toEqual(emptyState());

    await opens(b, "o/r#2");
    expect(await subjectsIn(a)).toEqual(["o/r#1"]);
    expect(await subjectsIn(b)).toEqual(["o/r#2"]);
  });

  it("lives in .loopway/state, which ignores everything in it", async () => {
    const a = await mkdtemp(join(tmpdir(), "loopway-a-"));
    await opens(a, "o/r#1");
    expect(stateDir(a, {})).toBe(join(a, ".loopway", "state"));
    expect(await readFile(join(a, ".loopway", "state", ".gitignore"), "utf8")).toBe("*\n");
    expect((await readdir(join(a, ".loopway", "state"))).sort()).toEqual([".gitignore", "threads"]);
  });

  it("leaves an edited .gitignore alone, and $LOOPWAY_STATE overrides the place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopway-s-"));
    await writeFile(join(dir, ".gitignore"), "mine\n");
    await saveState(dir, emptyState());
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("mine\n");
    expect(stateDir("/project", { LOOPWAY_STATE: dir })).toBe(dir);
  });
});
