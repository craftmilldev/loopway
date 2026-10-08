import { readFile } from "node:fs/promises";
import { ApiError, type Event, type LoopwayClient } from "../client.js";
import { loadGithubBot } from "../config.js";
import type { Context } from "../context.js";
import { dim } from "../format.js";
import { startMcpServer, type McpServer } from "../mcp.js";
import { spawnClaude, threadPrompt, type RunAgent } from "./agent.js";
import { botEnv } from "./github.js";
import { route, threadKeys } from "./routing.js";
import { editSession, loadSessions, sessionLogPath, withSessions, type Session, type Sessions } from "./store.js";
import { sessionTools } from "./tools.js";

export interface ThreadsOptions {
  max?: number;
  interval?: number;
  ttl?: number;
}

export const DEFAULTS = { max: 3, interval: 30, ttl: 3600 };

/** What a dispatcher is doing right now, for the TUI. */
export interface DispatcherState {
  /** Pending events not handed to a session yet: queued behind --max runs, or waiting for their session's run to exit. */
  raw: Event[];
  /** This inbox's sessions. */
  sessions: Sessions;
  /** Sessions with a run in flight. */
  running: ReadonlySet<string>;
}

/**
 * Hands one inbox's events to Claude Code sessions, one per thread. Each tick:
 *
 * 1. routes the pending events to sessions (see routing.ts), and
 * 2. marks each session's new events processed and starts or resumes it in the background.
 *
 * Delivered events are context for the session, not tasks it has to mark done. Sessions talk back
 * through the MCP tools in tools.ts, and `end` is what finishes a thread.
 */
export class Dispatcher {
  /** Session id → its run in flight. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly max: number;
  private readonly ttl: number;
  private readonly runAgent: RunAgent;
  private readonly dir: string;
  private queued = 0;
  private raw: Event[] = [];
  /** Whether a run has exited since the last tick started, and who to tell when one does. */
  private freed = false;
  private onFreed?: () => void;

  static async start(
    ctx: Context,
    client: LoopwayClient,
    inboxId: string,
    opts: ThreadsOptions = {},
  ): Promise<Dispatcher> {
    const prompt = await threadPrompt(inboxId);
    // With a GitHub bot configured, sessions comment, push and commit as it; otherwise as the user.
    const bot = await loadGithubBot(ctx.configDir, ctx.env);
    const env = bot ? botEnv(ctx.env, bot) : ctx.env;
    const mcp = await startMcpServer("loopway", sessionTools(ctx.configDir));
    return new Dispatcher(ctx, client, inboxId, opts, prompt, mcp, env);
  }

  private constructor(
    private readonly ctx: Context,
    private readonly client: LoopwayClient,
    private readonly inboxId: string,
    opts: ThreadsOptions,
    private readonly prompt: string,
    private readonly mcp: McpServer,
    /** The environment each session runs with. */
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.max = opts.max ?? DEFAULTS.max;
    this.ttl = opts.ttl ?? DEFAULTS.ttl;
    this.runAgent = ctx.runAgent ?? spawnClaude;
    this.dir = ctx.configDir;
  }

  async tick(): Promise<void> {
    this.freed = false;
    const pending = await this.listPending();
    const running = new Set(this.running.keys());
    const { deliveries, waiting } = await withSessions(this.dir, (sessions) =>
      route(sessions, pending, { inboxId: this.inboxId, max: this.max, running }),
    );
    this.reportWaiting(waiting);
    const handed = new Set([...deliveries.values()].flat().map((e) => e.id));
    this.raw = pending.filter((e) => !handed.has(e.id));
    for (const [id, events] of deliveries) await this.deliver(id, events);
  }

  /** The raw events as of the last tick, and this inbox's sessions as of now. */
  async state(): Promise<DispatcherState> {
    const all = await loadSessions(this.dir);
    const sessions = Object.fromEntries(Object.entries(all).filter(([, s]) => s.inbox_id === this.inboxId));
    return { raw: this.raw, sessions, running: new Set(this.running.keys()) };
  }

  /** A session's transcript so far, or "" if it hasn't written one. */
  readLog(id: string): Promise<string> {
    return readFile(sessionLogPath(this.dir, id), "utf8").catch(() => "");
  }

  /** Resolves once a run has exited since the last tick started, freeing its slot for a waiting event. */
  slotFreed(): Promise<void> {
    if (this.freed) return Promise.resolve();
    return new Promise((resolve) => (this.onFreed = resolve));
  }

  /** Resolves once every run in flight has exited. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values());
  }

  close(): Promise<void> {
    return this.mcp.close();
  }

  /** Marks a session's new events processed, records that they were delivered to it, and starts its run. */
  private async deliver(id: string, events: Event[]): Promise<void> {
    const claimed = await this.claimAll(events);
    const session = await withSessions(this.dir, (sessions) => {
      if (!claimed.length) {
        // Everything was claimed elsewhere first; a brand-new session has nothing to do.
        if (!sessions[id]?.started) delete sessions[id];
        return undefined;
      }
      const s = editSession(sessions, id);
      s.status = "active";
      s.events.push(...claimed.map((e) => e.id).filter((e) => !s.events.includes(e)));
      return { ...s };
    });
    // Not awaited: each session runs in the background, so threads proceed in parallel and the
    // next tick isn't held up. `running` tracks them for --max and for batching.
    if (session) this.running.set(id, this.run(id, session, claimed));
  }

  /** One agent run for a session: start it with the prompt, or resume it with just the new events. */
  private async run(id: string, session: Session, events: Event[]): Promise<void> {
    const short = id.slice(0, 8);
    const what = `${session.keys.join(", ") || "new thread"} (${events.length} event${events.length === 1 ? "" : "s"})`;
    this.ctx.out(`${session.started ? "resumed" : "started"} ${short} for ${what}`);

    const message = (session.started ? "" : this.prompt + "\n\n") + describeEvents(events);
    let code: number;
    try {
      code = await this.runAgent({
        sessionId: id,
        resume: session.started,
        message,
        logPath: sessionLogPath(this.dir, id),
        mcpUrl: this.mcp.urlFor(id),
        env: this.env,
      });
    } catch (err) {
      code = -1;
      this.ctx.out(`error: ${short} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ended = await withSessions(this.dir, (sessions) => {
      const s = editSession(sessions, id);
      s.started = true;
      return s.status === "ended";
    });
    this.ctx.out(`${short} ${ended ? "ended" : "finished"} (exit ${code})`);
    this.running.delete(id);
    this.freed = true;
    this.onFreed?.();
  }

  /** Locks each event, so no other consumer gets it too, then marks it processed with that lock. */
  private async claimAll(events: Event[]): Promise<Event[]> {
    const claimed: Event[] = [];
    for (const e of events) {
      try {
        const l = await this.client.lock(this.inboxId, e.id, { ttl_seconds: this.ttl });
        claimed.push(await this.client.processed(this.inboxId, e.id, { lock_token: l.lock.token }));
      } catch (err) {
        // Someone else claimed it between the list and the lock; it's theirs now.
        if (!(err instanceof ApiError && err.code === "locked")) throw err;
      }
    }
    return claimed;
  }

  private async listPending(): Promise<Event[]> {
    const query = { status: "pending", order: "asc", limit: 100 } as const;
    let page = await this.client.listEvents(this.inboxId, query);
    const events = [...page.data];
    while (page.next_cursor) {
      page = await this.client.listEvents(this.inboxId, { ...query, cursor: page.next_cursor });
      events.push(...page.data);
    }
    return events;
  }

  /** Says how many events are queued behind --max, only when that number changes. */
  private reportWaiting(waiting: number): void {
    if (waiting === this.queued) return;
    this.queued = waiting;
    if (waiting) this.ctx.out(dim(`${waiting} event(s) waiting: ${this.max} sessions are already running.`));
  }
}

function describeEvents(events: Event[]): string {
  const lines = events.map((e) =>
    `- ${e.id}  ${e.event.type}  ${threadKeys(e).key ?? e.event.subject ?? ""}`.trimEnd(),
  );
  return `New events for this thread:\n${lines.join("\n")}`;
}
