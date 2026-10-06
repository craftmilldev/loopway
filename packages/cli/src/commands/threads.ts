import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, type Event, type LoopwayClient } from "../client.js";
import { authedClient, type Context } from "../context.js";
import { dim } from "../format.js";
import { heldToken, rememberLock } from "../locks.js";
import { startMcpServer, type McpTool } from "../mcp.js";
import { findSession, loadSessions, saveSessions, sessionLogPath, updateSession, type Session } from "../threads.js";
import { resolveInbox } from "./inboxes.js";

/** One headless agent run: start session `sessionId` (or resume it) with `message`. Resolves to the exit code. */
export interface AgentRun {
  sessionId: string;
  resume: boolean;
  message: string;
  logPath: string;
  /** The dispatcher's MCP endpoint for this session (the `link` tool). */
  mcpUrl: string;
  env: NodeJS.ProcessEnv;
}

export interface ThreadsOptions {
  max?: number;
  interval?: number;
  ttl?: number;
}

const DEFAULTS = { max: 3, interval: 60, ttl: 3600 };

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
  let queued = 0;

  // threads.json is read-modify-written by ticks, finishing runs and the link tool; keep those from interleaving.
  let fileLock = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = fileLock.then(fn);
    fileLock = p.then(
      () => {},
      () => {},
    );
    return p;
  };

  const linkTool: McpTool = {
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
    call: (sessionId, args) => exclusive(() => link(sessionId, args)),
  };
  const mcp = await startMcpServer("loopway", [linkTool]);

  async function link(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const sessions = await loadSessions(ctx.configDir);
    const s = sessions[sessionId];
    if (!s) throw new Error(`No session ${sessionId}.`);
    const n = args.number;
    if (!Number.isInteger(n) || (n as number) < 1) throw new Error("number must be a positive integer.");
    const repo = typeof args.repo === "string" ? args.repo : s.keys[0]?.split("#")[0];
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Pass repo as owner/repo.");
    const key = `${repo}#${n}`;
    if (!s.keys.includes(key)) {
      s.keys.push(key);
      s.updated_at = new Date().toISOString();
      await saveSessions(ctx.configDir, sessions);
    }
    return `Linked ${key}; its events will come to this session.`;
  }

  async function tick() {
    await renewLocks();
    const pending = await listPending(client, inboxId);

    // Route every pending event to a session, creating sessions for events no thread claims.
    const deliveries = await exclusive(async () => {
      const sessions = await loadSessions(ctx.configDir);
      const now = new Date().toISOString();
      const groups = new Map<string, Event[]>();
      // Sessions holding a --max slot: every active one, plus ended ones resumed for late events.
      const slots = new Set(Object.keys(sessions).filter((id) => sessions[id]!.inbox_id === inboxId && isLive(id, sessions[id]!)));
      let dirty = false;
      let waiting = 0;
      for (const e of pending) {
        const { key, refs } = threadKeys(e);
        let id = key ? findSession(sessions, inboxId, key) : undefined;
        if (!id && key) {
          // A PR that says "Closes #N" belongs to issue N's thread, even before the agent links it.
          id = refs.map((r) => findSession(sessions, inboxId, r)).find(Boolean);
          if (id) {
            sessions[id]!.keys.push(key);
            sessions[id]!.updated_at = now;
            dirty = true;
          }
        }
        if (!id || !slots.has(id)) {
          // A new thread, or a late event for an ended one: either needs a free slot.
          if (slots.size >= max) {
            waiting++;
            continue;
          }
          if (!id) {
            id = randomUUID();
            sessions[id] = { inbox_id: inboxId, keys: key ? [key] : [], events: [], status: "active", started: false, created_at: now, updated_at: now };
            dirty = true;
          }
          slots.add(id);
        }
        // A busy session gets its new events together once its current run exits.
        if (running.has(id)) continue;
        groups.set(id, [...(groups.get(id) ?? []), e]);
      }
      if (dirty) await saveSessions(ctx.configDir, sessions);
      if (waiting !== queued) {
        queued = waiting;
        if (waiting) ctx.out(dim(`${waiting} event(s) waiting: all ${max} sessions are busy.`));
      }
      return [...groups].map(([id, events]) => ({ id, session: sessions[id]!, events }));
    });

    for (const { id, session, events } of deliveries) {
      const locked = await lockAll(events);
      if (locked.length) {
        const ids = locked.map((e) => e.id);
        await exclusive(() => updateSession(ctx.configDir, id, (s) => s.events.push(...ids.filter((e) => !s.events.includes(e)))));
        running.set(id, deliver(id, session, locked));
      } else if (!session.started) await exclusive(() => dropSession(id)); // all claimed elsewhere; free the slot
    }
  }

  const isLive = (id: string, s: Session) => s.status === "active" || running.has(id);

  /** Keeps every event a live session owns locked until it's processed; drops the ones that are. */
  async function renewLocks() {
    const sessions = await loadSessions(ctx.configDir);
    const released: [string, string][] = [];
    for (const [id, s] of Object.entries(sessions)) {
      if (s.inbox_id !== inboxId || !isLive(id, s)) continue;
      for (const eventId of s.events) {
        try {
          const token = await heldToken(ctx.configDir, inboxId, eventId);
          await rememberLock(ctx.configDir, await client.lock(inboxId, eventId, { ttl_seconds: ttl, lock_token: token }));
        } catch (err) {
          // 409: processed, or someone else took it after a lapse; 404: gone. Either way it isn't ours.
          if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) throw err;
          released.push([id, eventId]);
        }
      }
    }
    if (!released.length) return;
    await exclusive(async () => {
      const sessions = await loadSessions(ctx.configDir);
      for (const [id, eventId] of released) {
        if (sessions[id]) sessions[id]!.events = sessions[id]!.events.filter((e) => e !== eventId);
      }
      await saveSessions(ctx.configDir, sessions);
    });
  }

  async function lockAll(events: Event[]): Promise<Event[]> {
    const locked: Event[] = [];
    for (const e of events) {
      try {
        const l = await client.lock(inboxId, e.id, { ttl_seconds: ttl });
        // Remembered so renewals and the agent's `loopway events done` work without --token.
        await rememberLock(ctx.configDir, l);
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
    const message = (session.started ? "" : threadPrompt(inboxId) + "\n\n") + describeEvents(events);
    let code: number;
    try {
      code = await runAgent({
        sessionId: id,
        resume: session.started,
        message,
        logPath: sessionLogPath(ctx.configDir, id),
        mcpUrl: mcp.urlFor(id),
        env: ctx.env,
      });
    } catch (err) {
      code = -1;
      ctx.out(`error: ${short} failed to start: ${err instanceof Error ? err.message : err}`);
    }
    const closed = events.some((e) => CLOSE_TYPES.includes(e.event.type));
    await exclusive(() =>
      updateSession(ctx.configDir, id, (s) => {
        s.started = true;
        if (closed) s.status = "ended";
      }),
    );
    ctx.out(`${short} ${closed ? "ended" : "finished"} (exit ${code})`);
    running.delete(id);
  }

  async function dropSession(id: string) {
    const sessions = await loadSessions(ctx.configDir);
    delete sessions[id];
    await saveSessions(ctx.configDir, sessions);
  }

  /** Resolves once every run that's in flight has exited. */
  const idle = async () => {
    while (running.size) await Promise.all(running.values());
  };

  return { tick, idle, mcpUrl: mcp.urlFor, close: mcp.close };
}

const CLOSE_TYPES = ["com.github.issues.closed", "com.github.pull_request.closed"];

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
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link");
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

/** The instructions every session starts with. */
export function threadPrompt(inbox: string): string {
  return `You are a loopway thread session, working on events from inbox ${inbox}.

\`loopway threads\` polls the inbox for you. It started this session with the first event of a
thread (an issue, its PR, and their comments and reviews) and resumes it whenever new events for
that thread arrive. Do the work, then end your turn; you'll be resumed with the next events.
Don't poll the inbox, don't run \`loopway events next\`, and don't touch events you weren't given.

Each delivery lists event ids that are already locked for you. Read one with
\`loopway events get ${inbox} <event> --data\` and mark it done with
\`loopway events done ${inbox} <event>\` once you've handled it. The dispatcher keeps the lock on
every event you haven't marked done, so leave an event open for as long as you're still working
on it.

## 1. Triage
- Read the payload. If it is not an actionable issue or request (for example a bot comment edit),
  mark it done and end your turn.

## 2. Open questions
- Review the issue or comment and think about what open questions you have. If you have any,
  comment them on GitHub and end your turn. The replies come back to you as new events; mark
  those done as you read them. Once you're sure the questions are resolved, move on.

## 3. Work in a worktree
- Create a Claude-managed worktree with the EnterWorktree tool, named \`issue-<N>-<slug>\`. Never
  work on main. Each time you're resumed, check that you're still in it; if not, re-enter it with
  EnterWorktree (\`path\`: \`.claude/worktrees/issue-<N>-<slug>\`) before touching code.
- Read the surrounding code and match its style. Implement what the issue asks and
  nothing more; don't add tables, abstractions or features it didn't ask for.
- Run typecheck and tests before pushing. If a test fails, rerun it on the unmodified code
  to see whether it was already flaky, and say so.
- If a decision is truly the user's and the answer changes what you build, ask. Otherwise
  pick the obvious default and mention it in the PR.

## 4. Open the PR
- Commit, push, and open the PR with \`gh pr create\`. The body should say what changed and any
  deploy steps, such as env vars or migrations. Add \`Closes #<N>\`.
- Right away, call the \`link\` tool (loopway MCP server) with the PR number so the PR's events
  come to you.
- Mark the issue's event done once the PR is open.

## 5. Follow-up events
Handle each delivered event by type:

- \`com.github.pull_request_review_comment.*\` (inline review comment): a new comment from a human
  is feedback. Fix it in the worktree, commit (a new commit, never amend or force-push), and
  push. The payload gives you the comment id, \`path\`, \`line\`, and \`body\`. Reply on the thread
  with \`gh api repos/<org>/<repo>/pulls/<n>/comments/<comment_id>/replies -f body=...\`.
  Then mark the event done. If the body has a \`\`\`suggestion block, apply it exactly.
- \`com.github.pull_request_review.*\`: a review with an empty body just wraps its inline comments,
  so mark it done. If the body has content, treat it as feedback.
- \`com.github.issue_comment.*\` on the PR: if the author is a bot (vercel[bot] etc.), mark done
  with no action. Otherwise treat it as feedback and reply on the PR.
- \`com.github.pull_request.closed\` or \`com.github.issues.closed\` for your issue: go to step 6.
- If the PR description stops matching the code after a change, fix it.

## 6. On close
When a closed event for your PR or issue arrives:
1. Mark every remaining event you were given done.
2. Remove the worktree with ExitWorktree (\`action: "remove"\`), and delete the remote branch if
   it still exists.
3. Report what was done, what is still pending, and any deploy steps the user still has to do.
   This session ends after this turn.

## Reporting
Keep your final message for each turn short: what changed, and what you're waiting for.`;
}
