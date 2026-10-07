import { readFile } from "node:fs/promises";
import { ApiError, type Event, type LoopwayClient } from "../client.js";
import type { Context } from "../context.js";
import { dim } from "../format.js";
import { heldToken, rememberLock } from "../locks.js";
import { startMcpServer, type McpServer } from "../mcp.js";
import { spawnClaude, threadPrompt, type RunAgent } from "./agent.js";
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
 * 1. renews the locks on events that sessions still own,
 * 2. routes the pending events to sessions (see routing.ts), and
 * 3. locks each session's new events and starts or resumes it in the background.
 *
 * Sessions talk back through the MCP tools in tools.ts.
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

  static async start(ctx: Context, client: LoopwayClient, inboxId: string, opts: ThreadsOptions = {}): Promise<Dispatcher> {
    const prompt = await threadPrompt(inboxId);
    const mcp = await startMcpServer("loopway", sessionTools(ctx.configDir));
    return new Dispatcher(ctx, client, inboxId, opts, prompt, mcp);
  }

  private constructor(
    private readonly ctx: Context,
    private readonly client: LoopwayClient,
    private readonly inboxId: string,
    opts: ThreadsOptions,
    private readonly prompt: string,
    private readonly mcp: McpServer,
  ) {
    this.max = opts.max ?? DEFAULTS.max;
    this.ttl = opts.ttl ?? DEFAULTS.ttl;
    this.runAgent = ctx.runAgent ?? spawnClaude;
    this.dir = ctx.configDir;
  }

  async tick(): Promise<void> {
    this.freed = false;
    await this.renewLocks();
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

  /** Locks a session's new events, records that it owns them, and starts its run. */
  private async deliver(id: string, events: Event[]): Promise<void> {
    const locked = await this.lockAll(events);
    const session = await withSessions(this.dir, (sessions) => {
      if (!locked.length) {
        // Everything was claimed elsewhere first; a brand-new session has nothing to do.
        if (!sessions[id]?.started) delete sessions[id];
        return undefined;
      }
      const s = editSession(sessions, id);
      s.status = "active";
      s.events.push(...locked.map((e) => e.id).filter((e) => !s.events.includes(e)));
      return { ...s };
    });
    // Not awaited: each session runs in the background, so threads proceed in parallel and the
    // next tick isn't held up. `running` tracks them for --max and for batching.
    if (session) this.running.set(id, this.run(id, session, locked));
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
        env: this.ctx.env,
      });
    } catch (err) {
      code = -1;
      this.ctx.out(`error: ${short} failed to start: ${err instanceof Error ? err.message : err}`);
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

  /** Keeps every event a live session owns locked until it's processed; forgets the ones that are. */
  private async renewLocks(): Promise<void> {
    const sessions = await loadSessions(this.dir);
    const released: [string, string][] = [];
    for (const [id, s] of Object.entries(sessions)) {
      if (s.inbox_id !== this.inboxId || (s.status !== "active" && !this.running.has(id))) continue;
      for (const eventId of s.events) {
        try {
          const token = await heldToken(this.dir, this.inboxId, eventId);
          await rememberLock(this.dir, await this.client.lock(this.inboxId, eventId, { ttl_seconds: this.ttl, lock_token: token }));
        } catch (err) {
          // 409: processed, or someone else took it after a lapse; 404: gone. Either way it isn't ours.
          if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) throw err;
          released.push([id, eventId]);
        }
      }
    }
    if (!released.length) return;
    await withSessions(this.dir, (sessions) => {
      for (const [id, eventId] of released) {
        if (sessions[id]) sessions[id]!.events = sessions[id]!.events.filter((e) => e !== eventId);
      }
    });
  }

  private async lockAll(events: Event[]): Promise<Event[]> {
    const locked: Event[] = [];
    for (const e of events) {
      try {
        const l = await this.client.lock(this.inboxId, e.id, { ttl_seconds: this.ttl });
        // Remembered so renewals and the agent's `loopway events done` work without --token.
        await rememberLock(this.dir, l);
        locked.push(l);
      } catch (err) {
        // Someone else claimed it between the list and the lock; it's theirs now.
        if (!(err instanceof ApiError && err.code === "locked")) throw err;
      }
    }
    return locked;
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
  const lines = events.map((e) => `- ${e.id}  ${e.event.type}  ${threadKeys(e).key ?? e.event.subject ?? ""}`.trimEnd());
  return `New events for this thread (already locked for you):\n${lines.join("\n")}`;
}
