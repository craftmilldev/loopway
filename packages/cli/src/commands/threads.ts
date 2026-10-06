import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, type Event, type LoopwayClient } from "../client.js";
import { authedClient, type Context } from "../context.js";
import { dim } from "../format.js";
import { heldToken, rememberLock } from "../locks.js";
import { startMcpServer, type McpTool } from "../mcp.js";
import { findSession, loadSessions, sessionLogPath, withSessions, type Session } from "../threads.js";
import { resolveInbox } from "./inboxes.js";

/** One headless agent run: start session `sessionId` (or resume it) with `message`. Resolves to the exit code. */
export interface AgentRun {
  sessionId: string;
  resume: boolean;
  message: string;
  logPath: string;
  /** The dispatcher's MCP endpoint for this session (the `link` and `end` tools). */
  mcpUrl: string;
  env: NodeJS.ProcessEnv;
}

export interface ThreadsOptions {
  max?: number;
  interval?: number;
  ttl?: number;
}

const DEFAULTS = { max: 3, interval: 30, ttl: 3600 };

/** `loopway threads <inbox>`: poll forever, handing each pending event to its thread's session. */
export async function runThreads(ctx: Context, inboxRef: string, opts: ThreadsOptions) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const interval = opts.interval ?? DEFAULTS.interval;
  const d = await createDispatcher(ctx, client, inboxId, opts);
  ctx.out(`Watching ${inboxRef} every ${interval}s (at most ${opts.max ?? DEFAULTS.max} sessions). Ctrl-C to stop.`);
  for (;;) {
    try {
      await d.tick();
    } catch (err) {
      // A flaky network shouldn't take down running sessions; try again next tick.
      ctx.out(`error: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(interval * 1000);
  }
}

/** The polling core, split from runThreads so tests can drive it tick by tick. */
export async function createDispatcher(ctx: Context, client: LoopwayClient, inboxId: string, opts: ThreadsOptions) {
  const max = opts.max ?? DEFAULTS.max;
  const ttl = opts.ttl ?? DEFAULTS.ttl;
  const runAgent = ctx.runAgent ?? spawnClaude;
  const running = new Map<string, Promise<void>>();
  const dir = ctx.configDir;
  const prompt = await threadPrompt(inboxId);
  let queued = 0;

  // ---------- tools the sessions call back on ----------

  const tools: McpTool[] = [
    {
      name: "link",
      description:
        "Send an issue or PR's events to this session. Call it right after you open a PR, with the PR number, so reviews and comments on it come to you.",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "integer", description: "the issue or PR number" },
          repo: { type: "string", description: "owner/repo; defaults to this thread's repo" },
        },
        required: ["number"],
      },
      call: async (sessionId, args) => {
        const n = args.number;
        if (!Number.isInteger(n) || (n as number) < 1) throw new Error("number must be a positive integer.");
        return withSessions(dir, (sessions) => {
          const s = sessionFor(sessions, sessionId);
          const repo = typeof args.repo === "string" ? args.repo : s.keys[0]?.split("#")[0];
          if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Pass repo as owner/repo.");
          const key = `${repo}#${n}`;
          if (!s.keys.includes(key)) touch(s).keys.push(key);
          return `Linked ${key}; its events will come to this session.`;
        });
      },
    },
    {
      name: "end",
      description:
        "Tell the dispatcher this thread's work is finished (the PR is merged or closed for good, or the user asked you to stop). It frees this session's slot once your turn ends. A later event for the thread resumes you and makes it active again.",
      inputSchema: { type: "object", properties: {} },
      call: (sessionId) =>
        withSessions(dir, (sessions) => {
          touch(sessionFor(sessions, sessionId)).status = "ended";
          return "Ended. Your slot frees up when this turn finishes.";
        }),
    },
  ];
  const mcp = await startMcpServer("loopway", tools);

  // ---------- polling ----------

  async function tick() {
    await renewLocks();
    const pending = await listPending(client, inboxId);

    // Route every pending event to a session, creating sessions for events no thread claims.
    const deliveries = await withSessions(dir, (sessions) => {
      const now = new Date().toISOString();
      const groups = new Map<string, Event[]>();
      // Sessions holding a --max slot: every active one, plus ended ones still finishing a run.
      const slots = new Set(Object.keys(sessions).filter((id) => sessions[id]!.inbox_id === inboxId && isLive(id, sessions[id]!)));
      let waiting = 0;
      for (const e of pending) {
        const { key, refs } = threadKeys(e);
        let id = key ? findSession(sessions, inboxId, key) : undefined;
        if (!id && key) {
          // A PR that says "Closes #N" belongs to issue N's thread, even before the agent links it.
          id = refs.map((r) => findSession(sessions, inboxId, r)).find(Boolean);
          if (id) touch(sessions[id]!).keys.push(key);
        }
        if (!id || !slots.has(id)) {
          // A new thread, or a new event for an ended one: either needs a free slot.
          if (slots.size >= max) {
            waiting++;
            continue;
          }
          if (!id) {
            id = randomUUID();
            sessions[id] = { inbox_id: inboxId, keys: key ? [key] : [], events: [], status: "active", started: false, created_at: now, updated_at: now };
          }
          slots.add(id);
        }
        // A busy session gets its new events together once its current run exits.
        if (running.has(id)) continue;
        groups.set(id, [...(groups.get(id) ?? []), e]);
      }
      if (waiting !== queued) {
        queued = waiting;
        if (waiting) ctx.out(dim(`${waiting} event(s) waiting: all ${max} sessions are busy.`));
      }
      return [...groups].map(([id, events]) => ({ id, session: { ...sessions[id]! }, events }));
    });

    for (const { id, session, events } of deliveries) {
      const locked = await lockAll(events);
      if (!locked.length) {
        // All claimed elsewhere between the list and the lock; a brand-new session has nothing to do.
        if (!session.started) await withSessions(dir, (sessions) => void delete sessions[id]);
        continue;
      }
      await withSessions(dir, (sessions) => {
        const s = touch(sessionFor(sessions, id));
        s.status = "active";
        s.events.push(...locked.map((e) => e.id).filter((e) => !s.events.includes(e)));
      });
      // Not awaited: each session runs in the background, so threads proceed in parallel and the
      // next tick isn't held up. `running` tracks them for --max and for batching.
      running.set(id, deliver(id, session, locked));
    }
  }

  const isLive = (id: string, s: Session) => s.status === "active" || running.has(id);

  /** Keeps every event a live session owns locked until it's processed; drops the ones that are. */
  async function renewLocks() {
    const sessions = await loadSessions(dir);
    const released: [string, string][] = [];
    for (const [id, s] of Object.entries(sessions)) {
      if (s.inbox_id !== inboxId || !isLive(id, s)) continue;
      for (const eventId of s.events) {
        try {
          const token = await heldToken(dir, inboxId, eventId);
          await rememberLock(dir, await client.lock(inboxId, eventId, { ttl_seconds: ttl, lock_token: token }));
        } catch (err) {
          // 409: processed, or someone else took it after a lapse; 404: gone. Either way it isn't ours.
          if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) throw err;
          released.push([id, eventId]);
        }
      }
    }
    if (!released.length) return;
    await withSessions(dir, (sessions) => {
      for (const [id, eventId] of released) {
        if (sessions[id]) sessions[id]!.events = sessions[id]!.events.filter((e) => e !== eventId);
      }
    });
  }

  async function lockAll(events: Event[]): Promise<Event[]> {
    const locked: Event[] = [];
    for (const e of events) {
      try {
        const l = await client.lock(inboxId, e.id, { ttl_seconds: ttl });
        // Remembered so renewals and the agent's `loopway events done` work without --token.
        await rememberLock(dir, l);
        locked.push(l);
      } catch (err) {
        // Someone else claimed it between the list and the lock; it's theirs now.
        if (!(err instanceof ApiError && err.code === "locked")) throw err;
      }
    }
    return locked;
  }

  async function deliver(id: string, session: Session, events: Event[]) {
    const short = id.slice(0, 8);
    const what = `${session.keys.join(", ") || "new thread"} (${events.length} event${events.length === 1 ? "" : "s"})`;
    ctx.out(`${session.started ? "resumed" : "started"} ${short} for ${what}`);
    const message = (session.started ? "" : prompt + "\n\n") + describeEvents(events);
    let code: number;
    try {
      code = await runAgent({ sessionId: id, resume: session.started, message, logPath: sessionLogPath(dir, id), mcpUrl: mcp.urlFor(id), env: ctx.env });
    } catch (err) {
      code = -1;
      ctx.out(`error: ${short} failed to start: ${err instanceof Error ? err.message : err}`);
    }
    const ended = await withSessions(dir, (sessions) => {
      const s = touch(sessionFor(sessions, id));
      s.started = true;
      return s.status === "ended";
    });
    ctx.out(`${short} ${ended ? "ended" : "finished"} (exit ${code})`);
    running.delete(id);
  }

  /** Resolves once every run that's in flight has exited. */
  const idle = async () => {
    while (running.size) await Promise.all(running.values());
  };

  return { tick, idle, close: mcp.close };
}

function sessionFor(sessions: Record<string, Session>, id: string): Session {
  const s = sessions[id];
  if (!s) throw new Error(`No session ${id}.`);
  return s;
}

function touch(s: Session): Session {
  s.updated_at = new Date().toISOString();
  return s;
}

async function listPending(client: LoopwayClient, inboxId: string): Promise<Event[]> {
  let page = await client.listEvents(inboxId, { status: "pending", order: "asc", limit: 100 });
  const events = [...page.data];
  while (page.next_cursor) {
    page = await client.listEvents(inboxId, { status: "pending", order: "asc", limit: 100, cursor: page.next_cursor });
    events.push(...page.data);
  }
  return events;
}

interface GithubPayload {
  number?: number;
  issue?: { number?: number };
  pull_request?: { number?: number; body?: string | null };
  repository?: { full_name?: string };
}

/**
 * Which thread an event belongs to: `key` is its issue or PR (`owner/repo#number`), and `refs` are
 * the issues a PR body closes ("Closes #12"). Events with no issue or PR (e.g. push) have no key.
 */
export function threadKeys(e: Event): { key?: string; refs: string[] } {
  const d = (e.event.data ?? {}) as GithubPayload;
  const repo = d.repository?.full_name;
  const n = d.pull_request?.number ?? d.issue?.number ?? d.number;
  if (!repo || typeof n !== "number") return { refs: [] };
  const body = d.pull_request?.body ?? "";
  const refs = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => `${repo}#${m[1]}`);
  return { key: `${repo}#${n}`, refs };
}

function describeEvents(events: Event[]): string {
  const lines = events.map((e) => `- ${e.id}  ${e.event.type}  ${threadKeys(e).key ?? e.event.subject ?? ""}`.trimEnd());
  return `New events for this thread (already locked for you):\n${lines.join("\n")}`;
}

/** Runs `claude -p` headless in the current directory, appending its stream-json transcript to the log. */
async function spawnClaude(run: AgentRun): Promise<number> {
  await mkdir(dirname(run.logPath), { recursive: true, mode: 0o700 });
  const log = await open(run.logPath, "a", 0o600);
  try {
    const mcpConfig = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
    const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
    // --mcp-config and --allowedTools take several values, so each is followed by another flag.
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link", "mcp__loopway__end");
    args.push("--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
    const child = spawn("claude", args, { env: run.env, stdio: ["pipe", log.fd, log.fd] });
    child.stdin!.end(run.message);
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
  } finally {
    await log.close();
  }
}

/** packages/cli/prompts/thread.md; the same relative path works from src/ and from the built dist/. */
const PROMPT_FILE = new URL("../../prompts/thread.md", import.meta.url);

/** The instructions every session starts with. */
export async function threadPrompt(inbox: string): Promise<string> {
  return (await readFile(PROMPT_FILE, "utf8")).replaceAll("{{inbox}}", inbox).trimEnd();
}
