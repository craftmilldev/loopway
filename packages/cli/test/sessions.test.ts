import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bot } from "../src/bots.js";
import type { AgentRun, RunAgent, RunOutcome } from "../src/claude.js";
import { formatLine, type SessionEvent } from "../src/format.js";
import { Sessions, RETRY_AFTER_FAILURE_MS } from "../src/sessions.js";
import { loadThreads, Threads, threadLogPath } from "../src/threads.js";
import { markerOf, type Thread } from "../src/thread.js";
import { aBot, aThread, anUpdate } from "./make.js";

const ok: RunOutcome = { code: 0, finished: true };

const withModel = { ...aBot("dev", ["issue"]), model: "sonnet" };

/** An agent standing in for Claude Code: each run is recorded, and `behave` says what it does. */
function fakeAgent() {
  const runs: AgentRun[] = [];
  const agent = {
    runs,
    behave: (async () => ok) as (run: AgentRun) => Promise<RunOutcome>,
    run: (async (run) => {
      runs.push(run);
      run.onStarted();
      run.onLine("working");
      return agent.behave(run);
    }) as RunAgent,
  };
  return agent;
}

const queued = (thread: Thread, ...updates: [id: string, at: string][]) => {
  for (const [id, at] of updates)
    thread.queue.push({ ...anUpdate(id, "comment", at), subject: thread.subjects[0]!.key });
  return thread;
};

async function setup(opts: { max?: number; bots?: Bot[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "loopway-sessions-"));
  const threads = await Threads.load({ dir, bots: [] });
  const agent = fakeAgent();
  const events: SessionEvent[] = [];
  const posted: string[] = [];
  /** Set `refuses` to make GitHub turn comments down with that message. */
  const github = { refuses: "" };
  const clock = { t: Date.parse("2026-11-10T15:00:00Z") };
  const sessions = new Sessions({
    dir,
    threads,
    bots: opts.bots ?? [withModel],
    root: "/root",
    max: opts.max ?? 3,
    runAgent: agent.run,
    mcpUrl: (id) => `http://mcp/${id}`,
    env: { GH_TOKEN: "bot-token", GIT_AUTHOR_NAME: "loopway-bot" },
    commenter: {
      comment: async (subject, body) => {
        if (github.refuses) throw new Error(github.refuses);
        posted.push(`${subject}: ${body}`);
        return `https://github.com/${subject}#issuecomment-1`;
      },
    },
    emit: (e) => events.push(e),
    now: () => clock.t,
    newSessionId: () => "session-1",
  });
  const add = (thread: Thread) => (threads.all.push(thread), thread);
  const files = () => loadThreads(dir);
  const log = (id: string) => readFile(threadLogPath(dir, id), "utf8");
  return { dir, threads, agent, events, posted, github, clock, sessions, add, files, log };
}

describe("delivery", () => {
  it("gives a thread every queued update in one run, oldest first, and empties the queue", async () => {
    const s = await setup();
    const thread = s.add(
      queued(
        aThread("t1", "dev", ["o/r#12"]),
        ["comment:2", "2026-11-10T14:10:00Z"],
        ["comment:1", "2026-11-10T14:05:00Z"],
      ),
    );
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(1);
    const run = s.agent.runs[0]!;
    expect(run).toMatchObject({
      resume: false,
      sessionId: "session-1",
      model: "sonnet",
      cwd: "/root",
      mcpUrl: "http://mcp/t1",
    });
    expect(run.message).toMatch(/You are loopway-bot/);
    expect(run.message).toMatch(
      /2 updates since your last turn, oldest first:\n- 2026-11-10T14:05:00Z o\/r#12 comment by me\n- 2026-11-10T14:10:00Z/,
    );
    expect(thread.queue).toEqual([]);
    expect(thread.session).toMatchObject({ id: "session-1", status: "idle", lastRunAt: "2026-11-10T15:00:00.000Z" });
    expect((await s.files())[0]?.queue).toEqual([]);
  });

  it("starts the session as loopway-bot: the token and git identity are in its environment", async () => {
    const s = await setup();
    s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs[0]?.env).toMatchObject({ GH_TOKEN: "bot-token", GIT_AUTHOR_NAME: "loopway-bot" });
  });

  it("resumes the same session for the next batch, without the prompt again", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.sessions.kick();
    await s.sessions.idle();
    queued(thread, ["c:2", "2026-11-10T14:20:00Z"]);
    s.sessions.kick();
    await s.sessions.idle();
    const [first, second] = s.agent.runs;
    expect([first?.resume, second?.resume, second?.sessionId]).toEqual([false, true, "session-1"]);
    expect(second?.message).not.toMatch(/You are loopway-bot/);
    expect(second?.message).toMatch(/1 updates since your last turn/);
  });

  it("keeps what arrives during a run for the next one", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async (run) => {
      if (!run.resume) queued(thread, ["c:2", "2026-11-10T14:06:00Z"]);
      return ok;
    };
    s.sessions.kick();
    await s.sessions.idle();
    expect(thread.queue).toEqual([]);
    expect(s.agent.runs.map((r) => r.message.includes("14:06"))).toEqual([false, true]);
  });

  it("runs at most --max threads at once, and starts the next as one ends", async () => {
    const s = await setup({ max: 2 });
    for (const id of ["t1", "t2", "t3"])
      s.add(queued(aThread(id, "dev", [`o/r#${id}`]), [`c:${id}`, "2026-11-10T14:05:00Z"]));
    const release: (() => void)[] = [];
    s.agent.behave = () => new Promise((resolve) => release.push(() => resolve(ok)));
    s.sessions.kick();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.agent.runs.map((r) => r.mcpUrl).sort()).toEqual(["http://mcp/t1", "http://mcp/t2"]);
    release[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.agent.runs).toHaveLength(3);
    release[1]!();
    release[2]!();
    await s.sessions.idle();
    expect(s.threads.all.every((t) => t.queue.length === 0)).toBe(true);
  });

  it("does not deliver to a closed thread, or one with nothing queued", async () => {
    const s = await setup();
    s.add(queued(aThread("t1", "dev", ["o/r#1"], "closed"), ["c:1", "2026-11-10T14:05:00Z"]));
    s.add({ ...aThread("t2", "dev", ["o/r#2"]), session: { id: "s2", status: "idle", lastRunAt: null } });
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toEqual([]);
  });

  it("gives a thread that has never run its first run even with nothing queued, since a new subject is the news", async () => {
    const s = await setup();
    s.add(aThread("t1", "dev", ["o/r#12"]));
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(1);
    expect(s.agent.runs[0]?.message).toMatch(/just opened/);
    expect(s.agent.runs[0]?.message).toMatch(/This thread tracks: o\/r#12/);
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(1);
  });

  it("logs the run, the delivery and what the session said in the thread's log file", async () => {
    const s = await setup();
    s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.sessions.kick();
    await s.sessions.idle();
    expect(await s.log("t1")).toBe("-> delivered 1 updates\nworking\nturn ended without a message\n");
  });
});

describe("failures", () => {
  it("puts the updates back, marks the session failed, and says so", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async () => ({ code: 0, finished: true, apiError: "API Error: 529 overloaded" });
    s.sessions.kick();
    await s.sessions.idle();
    expect(thread.queue.map((q) => q.id)).toEqual(["c:1"]);
    expect(thread.session).toMatchObject({ status: "failed", lastError: "API Error: 529 overloaded" });
    expect(s.events.map((e) => formatLine(e).slice(17))).toEqual([
      "run started t1 dev (new session), delivered 1 updates",
      "run failed t1: API Error: 529 overloaded; 1 updates back in the queue",
    ]);
    expect(await s.log("t1")).toMatch(/!! run failed: API Error: 529 overloaded/);
  });

  it("counts a bad exit code, or a run with no result, as a failure", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async () => ({ code: 1, finished: false });
    s.sessions.kick();
    await s.sessions.idle();
    expect(thread.session?.lastError).toBe("claude exited with code 1");
    s.clock.t += RETRY_AFTER_FAILURE_MS;
    s.agent.behave = async () => ({ code: 0, finished: false });
    s.sessions.kick();
    await s.sessions.idle();
    expect(thread.session?.lastError).toBe("the run ended without a result");
    expect(thread.queue).toHaveLength(1);
  });

  it("tries again after a wait, and the thread is idle once a run works", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async () => ({ code: 1, finished: false });
    s.sessions.kick();
    await s.sessions.idle();
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(1);
    s.clock.t += RETRY_AFTER_FAILURE_MS;
    s.agent.behave = async () => ok;
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(2);
    expect(thread.queue).toEqual([]);
    expect(thread.session?.status).toBe("idle");
    expect(thread.session?.lastError).toBeUndefined();
  });

  it("holds every delivery until the usage limit resets", async () => {
    const s = await setup();
    const reset = s.clock.t + 3_600_000;
    const hit = s.add(queued(aThread("t1", "dev", ["o/r#1"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async () => ({ code: 0, finished: true, limitedUntil: reset });
    s.sessions.kick();
    await s.sessions.idle();
    expect(hit.session?.lastError).toMatch(
      /usage limit reached, holding every delivery until 2026-11-10T16:00:00.000Z/,
    );
    s.add(queued(aThread("t2", "dev", ["o/r#2"]), ["c:2", "2026-11-10T14:06:00Z"]));
    s.agent.behave = async () => ok;
    s.clock.t = reset - 1;
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(1);
    s.clock.t = reset;
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.agent.runs).toHaveLength(3);
  });

  it("fails a thread whose bot is gone", async () => {
    const s = await setup();
    const noBot = s.add(queued(aThread("t2", "gone", ["o/r#2"]), ["c:2", "2026-11-10T14:05:00Z"]));
    s.sessions.kick();
    await s.sessions.idle();
    expect(noBot.session?.lastError).toBe("there is no bot gone in .loopway/");
    expect(s.agent.runs).toEqual([]);
  });

  it("makes a run that was cut off by a restart idle again, with its updates still queued", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#1"]), ["c:1", "2026-11-10T14:05:00Z"]));
    thread.session = { id: null, status: "running", lastRunAt: "2026-11-10T14:59:00Z" };
    const stop = new AbortController();
    const running = s.sessions.run(stop.signal, () => new Promise((resolve) => setTimeout(resolve, 5)));
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await running;
    expect(s.agent.runs).toHaveLength(1);
    expect(thread.session?.status).toBe("idle");
  });
});

describe("messages a session sends", () => {
  it("are posted with the thread's marker, recorded as sent, and logged", async () => {
    const s = await setup();
    const thread = s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async () => {
      await s.sessions.comment("t1", "o/r#12", "It is 4.");
      return ok;
    };
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.posted).toEqual([`o/r#12: It is 4.\n\n${markerOf("t1")}`]);
    expect(thread.sent).toEqual([
      {
        at: "2026-11-10T15:00:00.000Z",
        subject: "o/r#12",
        kind: "comment",
        url: "https://github.com/o/r#12#issuecomment-1",
      },
    ]);
    expect((await s.files())[0]?.sent).toHaveLength(1);
    expect(await s.log("t1")).toContain("<- comment on o/r#12\n");
    expect(s.events.map((e) => e.type)).toEqual(["run_started", "sent", "run_finished"]);
  });

  it("say nothing about a silent turn when the turn sent one", async () => {
    const s = await setup();
    s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.agent.behave = async () => {
      await s.sessions.comment("t1", "o/r#12", "hi");
      return ok;
    };
    s.sessions.kick();
    await s.sessions.idle();
    expect(await s.log("t1")).not.toContain("without a message");
  });

  it("log `turn ended without a message` when a turn sent none", async () => {
    const s = await setup();
    s.add(queued(aThread("t1", "dev", ["o/r#12"]), ["c:1", "2026-11-10T14:05:00Z"]));
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.events.map((e) => formatLine(e).slice(17))).toContain("turn ended without a message t1");
    expect(await s.log("t1")).toContain("turn ended without a message\n");
  });

  it("that GitHub refuses are logged on the thread, not recorded as sent, and fail for the session", async () => {
    const s = await setup();
    const thread = s.add(aThread("t1", "dev", ["o/r#12"]));
    s.github.refuses = "GitHub 401 Bad credentials";
    await expect(s.sessions.comment("t1", "o/r#12", "hi")).rejects.toThrow("401");
    expect(thread.sent).toBeUndefined();
    expect(await s.log("t1")).toBe("!! comment on o/r#12 failed: GitHub 401 Bad credentials\n");
  });

  it("only go to subjects in a repo the bot reads, and need a real subject", async () => {
    const s = await setup();
    s.add(aThread("t1", "dev", ["o/r#12"]));
    await expect(s.sessions.comment("t1", "other/repo#1", "x")).rejects.toThrow("dev does not read other/repo");
    await expect(s.sessions.comment("t1", "o/r", "x")).rejects.toThrow('"o/r" is not a subject');
    await expect(s.sessions.comment("nope", "o/r#1", "x")).rejects.toThrow("there is no thread nope");
    expect(s.posted).toEqual([]);
  });
});
