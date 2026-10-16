import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRun } from "@loopway/harnesses";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BbSessions, type SessionsOptions } from "../sessions.js";

interface FakeThread {
  id: string;
  status: string;
  queuedMessageCount: number;
  deletedAt: number | null;
}

/** A bb thread store whose threads go active when sent a message, and idle when the test says. */
function fakeThreads() {
  const threads = new Map<string, FakeThread>();
  let next = 1;
  const api = {
    spawn: vi.fn<(args: Record<string, unknown>) => Promise<FakeThread>>(async () => {
      const thread = { id: `thr_${next++}`, status: "active", queuedMessageCount: 0, deletedAt: null };
      threads.set(thread.id, thread);
      return thread;
    }),
    send: vi.fn(async ({ threadId }: { threadId: string }) => {
      threads.get(threadId)!.status = "active";
      return { ok: true, delivery: "sent" };
    }),
    get: vi.fn(async ({ threadId }: { threadId: string }) => {
      const thread = threads.get(threadId);
      if (!thread) throw Object.assign(new Error("Thread not found"), { status: 404 });
      return { ...thread };
    }),
  };
  return { threads, api };
}

function fakeKv(): PluginKvStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
    list: async (prefix = "") => [...data.keys()].filter((k) => k.startsWith(prefix)),
  };
}

let dir: string;
let store: ReturnType<typeof fakeThreads>;
let kv: ReturnType<typeof fakeKv>;
let stop: AbortController;
let sessions: BbSessions;

function make(overrides: Partial<SessionsOptions> = {}) {
  return new BbSessions({
    threads: store.api as unknown as SessionsOptions["threads"],
    kv,
    projectId: "proj_1",
    describe: async () => ({ prompt: "BOT PROMPT", title: "reviewer: o/r#12" }),
    log: () => {},
    pollMs: 20,
    signal: stop.signal,
    ...overrides,
  });
}

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  harness: "claude",
  sessionId: "lw-thread-1",
  resume: false,
  message: "BOT PROMPT\n\nNew messages for this thread: ...",
  model: "opus",
  logPath: join(dir, "threads", "lw-thread-1.log"),
  mcpUrl: "http://127.0.0.1:1/x/lw-thread-1",
  env: {},
  ...overrides,
});

/** Lets the run get as far as waiting on its bb thread. */
const settleSoon = () => sleep(5);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-loopway-"));
  store = fakeThreads();
  kv = fakeKv();
  stop = new AbortController();
  sessions = make();
});

describe("BbSessions", () => {
  it("starts a bb thread for a new loopway thread, maps them, and finishes when it goes idle", async () => {
    const onStarted = vi.fn();
    const outcome = sessions.run(run({ onStarted }));
    await settleSoon();
    expect(store.api.spawn).toHaveBeenCalledWith({
      projectId: "proj_1",
      environment: { type: "project-default" },
      prompt: "BOT PROMPT\n\nNew messages for this thread: ...",
      title: "reviewer: o/r#12",
      pluginMetadata: { loopwayThreadId: "lw-thread-1" },
    });
    expect(await sessions.bbThreadFor("lw-thread-1")).toBe("thr_1");
    expect(await sessions.loopwayThreadFor("thr_1")).toBe("lw-thread-1");
    expect(onStarted).toHaveBeenCalledOnce();

    store.threads.get("thr_1")!.status = "idle";
    sessions.poke("thr_1");
    expect(await outcome).toEqual({ code: 0, delivered: true, finished: true });

    const log = await readFile(run().logPath, "utf8");
    expect(log).toContain('"subtype":"init"');
    expect(log.trimEnd().split("\n").at(-1)).toContain('"type":"result"');
  });

  it("sends a later message to the bb thread its loopway thread already has", async () => {
    await kv.set("thread:lw-thread-1", "thr_9");
    await kv.set("bb:thr_9", "lw-thread-1");
    store.threads.set("thr_9", { id: "thr_9", status: "idle", queuedMessageCount: 0, deletedAt: null });

    const outcome = sessions.run(run({ resume: true, message: "New messages for this thread: ..." }));
    await settleSoon();
    expect(store.api.spawn).not.toHaveBeenCalled();
    expect(store.api.send).toHaveBeenCalledWith({
      threadId: "thr_9",
      mode: "auto",
      input: [{ type: "text", text: "New messages for this thread: ...", mentions: [] }],
    });
    store.threads.get("thr_9")!.status = "idle";
    expect((await outcome).code).toBe(0);
  });

  it("waits while the message is still queued behind another turn", async () => {
    const outcome = sessions.run(run());
    await settleSoon();
    const thread = store.threads.get("thr_1")!;
    // An earlier turn ends with ours still in the queue: not done yet.
    Object.assign(thread, { status: "idle", queuedMessageCount: 1 });
    sessions.poke("thr_1");
    let done = false;
    void outcome.then(() => (done = true));
    await sleep(50);
    expect(done).toBe(false);

    Object.assign(thread, { status: "idle", queuedMessageCount: 0 });
    expect((await outcome).code).toBe(0);
  });

  it("doesn't take a stale idle for a finished turn", async () => {
    const outcome = sessions.run(run());
    await settleSoon();
    const thread = store.threads.get("thr_1")!;
    // Idle before the thread has picked the message up.
    thread.status = "idle";
    sessions.poke("thr_1");
    let done = false;
    void outcome.then(() => (done = true));
    await sleep(20);
    expect(done).toBe(false);

    thread.status = "active";
    await sleep(20);
    thread.status = "idle";
    expect((await outcome).code).toBe(0);
  });

  it("finds a finished turn by polling when no event comes", async () => {
    const outcome = sessions.run(run());
    await settleSoon();
    store.threads.get("thr_1")!.status = "idle";
    expect((await outcome).code).toBe(0);
  });

  it("reports a failed bb turn as a failed run", async () => {
    const outcome = sessions.run(run());
    await settleSoon();
    store.threads.get("thr_1")!.status = "error";
    sessions.poke("thr_1");
    expect(await outcome).toEqual({ code: 1, delivered: true, finished: true });
  });

  it("starts a resumed thread over, with the bot prompt, when it has no bb thread", async () => {
    const outcome = sessions.run(run({ resume: true, message: "New messages for this thread: ..." }));
    await settleSoon();
    const prompt = store.api.spawn.mock.calls[0]![0].prompt as string;
    expect(prompt.startsWith("BOT PROMPT\n\n")).toBe(true);
    expect(prompt).toContain("starting fresh");
    expect(prompt.endsWith("New messages for this thread: ...")).toBe(true);
    store.threads.get("thr_1")!.status = "idle";
    await outcome;
  });

  it("starts over in a new bb thread when the mapped one was deleted", async () => {
    await kv.set("thread:lw-thread-1", "thr_9");
    await kv.set("bb:thr_9", "lw-thread-1");
    store.threads.set("thr_9", { id: "thr_9", status: "idle", queuedMessageCount: 0, deletedAt: 123 });

    const outcome = sessions.run(run({ resume: true }));
    await settleSoon();
    expect(store.api.send).not.toHaveBeenCalled();
    expect(await sessions.bbThreadFor("lw-thread-1")).toBe("thr_1");
    expect(await sessions.loopwayThreadFor("thr_9")).toBeUndefined();
    store.threads.get("thr_1")!.status = "idle";
    await outcome;
  });

  it("ends the run when its bb thread is deleted mid-turn, and forgets the pair", async () => {
    const outcome = sessions.run(run());
    await settleSoon();
    await sessions.forget("thr_1");
    expect((await outcome).code).toBe(1);
    expect(await sessions.bbThreadFor("lw-thread-1")).toBeUndefined();
  });

  it("hands a failed spawn back as an API error, so the dispatcher retries it", async () => {
    store.api.spawn.mockRejectedValueOnce(new Error("project not found"));
    expect(await sessions.run(run())).toEqual({ code: -1, delivered: false, apiError: "project not found" });
  });

  it("leaves a run cut off when the runner stops, for the next runner to requeue", async () => {
    const outcome = sessions.run(run());
    await settleSoon();
    stop.abort();
    const result = await Promise.race([outcome, sleep(80).then(() => "pending")]);
    expect(result).toBe("pending");
    const log = await readFile(run().logPath, "utf8");
    expect(log).not.toContain('"type":"result"');
  });

  it("lists every loopway thread → bb thread pair", async () => {
    await kv.set("thread:a", "thr_a");
    await kv.set("bb:thr_a", "a");
    await kv.set("thread:b", "thr_b");
    expect(await sessions.pairs()).toEqual([
      { loopwayThreadId: "a", bbThreadId: "thr_a" },
      { loopwayThreadId: "b", bbThreadId: "thr_b" },
    ]);
  });
});
