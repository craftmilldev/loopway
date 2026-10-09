import { readFile } from "node:fs/promises";
import { ApiError, type Bot, type Event, type Lease, type LoopwayClient } from "../client.js";
import { loadGithubBot } from "../config.js";
import type { Context } from "../context.js";
import { dim } from "../format.js";
import { startMcpServer, type McpServer } from "../mcp.js";
import { spawnClaude, type RunAgent } from "./agent.js";
import { botEnv } from "./github.js";
import { BOT_KINDS, type BotKind } from "./kinds.js";
import {
  adoptSessions,
  editSession,
  loadSessions,
  sessionLogPath,
  withSessions,
  type Session,
  type Sessions,
  type WaitingMessage,
} from "./store.js";
import { sessionTools } from "./tools.js";

export interface ThreadsOptions {
  max?: number;
  interval?: number;
  /** How long each bot lease lasts; it's renewed every tick. */
  ttl?: number;
}

export const DEFAULTS = { max: 3, interval: 30, ttl: 3600 };

/** What a dispatcher is doing right now, for the TUI. */
export interface DispatcherState {
  /** The bots this runner holds a lease on, and the ones it skipped because another runner holds theirs. */
  bots: { held: Bot[]; skipped: Bot[] };
  /** Messages assigned to a session but not delivered yet, oldest first. */
  waiting: WaitingMessage[];
  /** The sessions of this runner's bots. */
  sessions: Sessions;
  /** Sessions with a run in flight. */
  running: ReadonlySet<string>;
}

/**
 * Runs the bots of this account: hands their messages to Claude Code sessions, one per thread.
 * Each tick, per bot it holds a lease on:
 *
 * 1. reads the messages after the bot's cursor,
 * 2. assigns each one to a session with the bot kind's `route` (see kinds.ts), saves that, and
 *    moves the cursor past them;
 *
 * then starts or resumes, in the background, every session that has waiting messages and no run in
 * flight, as far as --max allows.
 *
 * Delivered messages are context for the session, not tasks it has to mark done; the inbox's events
 * are left alone. Sessions talk back through the MCP tools in tools.ts, and `end` is what finishes
 * a thread.
 */
export class Dispatcher {
  /** Session id → its run in flight. */
  private readonly running = new Map<string, Promise<void>>();
  /** Bot id → the lease this runner holds. */
  private readonly leases = new Map<string, Lease>();
  /** Bots skipped last tick because another runner holds their lease. */
  private readonly skipped = new Set<string>();
  private readonly max: number;
  private readonly ttl: number;
  private readonly runAgent: RunAgent;
  private readonly dir: string;
  private queued = 0;
  /** Whether a run has exited since the last tick started, and who to tell when one does. */
  private freed = false;
  private onFreed?: () => void;

  /** `bots` must all be of a kind in BOT_KINDS. */
  static async start(ctx: Context, client: LoopwayClient, bots: Bot[], opts: ThreadsOptions = {}): Promise<Dispatcher> {
    const kinds = new Map<string, BotKind>();
    const prompts = new Map<string, string>();
    for (const bot of bots) {
      const kind = BOT_KINDS[bot.kind];
      if (!kind) throw new Error(`Bot ${bot.name} has kind ${bot.kind}, which this CLI can't run.`);
      kinds.set(bot.id, kind);
      prompts.set(bot.id, await kind.prompt());
    }
    const adopted = await withSessions(ctx.configDir, (sessions) => adoptSessions(sessions, bots));
    if (adopted) ctx.out(dim(`Adopted ${adopted} session(s) from before bots.`));
    // With a GitHub bot configured, sessions comment, push and commit as it; otherwise as the user.
    const gh = await loadGithubBot(ctx.configDir, ctx.env);
    const env = gh ? botEnv(ctx.env, gh) : ctx.env;
    const mcp = await startMcpServer("loopway", sessionTools(ctx.configDir));
    return new Dispatcher(ctx, client, bots, kinds, prompts, opts, mcp, env);
  }

  private constructor(
    private readonly ctx: Context,
    private readonly client: LoopwayClient,
    private readonly bots: Bot[],
    private readonly kinds: Map<string, BotKind>,
    private readonly prompts: Map<string, string>,
    opts: ThreadsOptions,
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
    for (const bot of this.bots) {
      try {
        if (await this.lease(bot)) await this.poll(bot);
      } catch (err) {
        // One bot's trouble (a flaky network, say) shouldn't stop the others; try again next tick.
        this.ctx.out(`error: bot ${bot.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.deliverAll();
  }

  /** The waiting messages and sessions of this runner's bots, as of now. */
  async state(): Promise<DispatcherState> {
    const all = await loadSessions(this.dir);
    const mine = new Set(this.bots.map((b) => b.id));
    const sessions = Object.fromEntries(Object.entries(all).filter(([, s]) => mine.has(s.bot_id)));
    const waiting = Object.values(sessions)
      .flatMap((s) => s.waiting)
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      bots: {
        held: this.bots.filter((b) => this.leases.has(b.id)),
        skipped: this.bots.filter((b) => this.skipped.has(b.id)),
      },
      waiting,
      sessions,
      running: new Set(this.running.keys()),
    };
  }

  /** A session's transcript so far, or "" if it hasn't written one. */
  readLog(id: string): Promise<string> {
    return readFile(sessionLogPath(this.dir, id), "utf8").catch(() => "");
  }

  /** Resolves once a run has exited since the last tick started, freeing its slot for a waiting session. */
  slotFreed(): Promise<void> {
    if (this.freed) return Promise.resolve();
    return new Promise((resolve) => (this.onFreed = resolve));
  }

  /** Resolves once every run in flight has exited. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values());
  }

  /** Releases the bot leases, so the next runner needn't wait out the TTL, and stops the MCP server. */
  async close(): Promise<void> {
    for (const [id, lease] of this.leases) {
      // A lease that expired or was taken over is gone already; nothing to do about it on the way out.
      await this.client.releaseBot(id, lease.token).catch(() => {});
      this.leases.delete(id);
    }
    await this.mcp.close();
  }

  /** Takes or renews the bot's lease. False, with a log line the first time, if another runner holds it. */
  private async lease(bot: Bot): Promise<boolean> {
    try {
      const { lease } = await this.client.leaseBot(bot.id, {
        ttl_seconds: this.ttl,
        lease_token: this.leases.get(bot.id)?.token,
      });
      this.leases.set(bot.id, lease);
      if (this.skipped.delete(bot.id)) this.ctx.out(`bot ${bot.name}: lease taken`);
      return true;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "leased")) throw err;
      this.leases.delete(bot.id);
      if (!this.skipped.has(bot.id)) {
        this.skipped.add(bot.id);
        this.ctx.out(`bot ${bot.name} is leased by another runner; skipping it until that lease ends.`);
      }
      return false;
    }
  }

  /** Reads the bot's messages until there are none, assigning each page to sessions and moving the cursor past it. */
  private async poll(bot: Bot): Promise<void> {
    for (;;) {
      const messages = await this.client.botMessages(bot.id, { limit: 100 });
      if (!messages.length) return;
      await this.assign(bot, messages);
      await this.client.advanceCursor(bot.id, messages.at(-1)!.seq, this.leases.get(bot.id)!.token);
    }
  }

  /**
   * Gives each message to a session, as a waiting message. Messages already assigned (the last run
   * died between saving and moving the cursor) are skipped.
   */
  private assign(bot: Bot, messages: Event[]): Promise<void> {
    const kind = this.kinds.get(bot.id)!;
    return withSessions(this.dir, (sessions) => {
      const known = new Set(Object.values(sessions).flatMap((s) => [...s.events, ...s.waiting.map((m) => m.id)]));
      for (const e of messages) {
        if (known.has(e.id)) continue;
        const { session, key } = kind.route(sessions, bot.id, e);
        editSession(sessions, session).waiting.push({ id: e.id, inbox_id: e.inbox_id, type: e.event.type, key });
      }
    });
  }

  /** Starts or resumes every session with waiting messages and no run in flight, oldest first, while --max allows. */
  private async deliverAll(): Promise<void> {
    const running = new Set(this.running.keys());
    const { deliveries, held } = await withSessions(this.dir, (sessions) => {
      const ready = Object.keys(sessions)
        .filter((id) => sessions[id]!.waiting.length && !running.has(id) && this.prompts.has(sessions[id]!.bot_id))
        .sort((a, b) => sessions[a]!.waiting[0]!.id.localeCompare(sessions[b]!.waiting[0]!.id));
      const deliveries = new Map<string, { session: Session; messages: WaitingMessage[] }>();
      for (const id of ready) {
        if (running.size + deliveries.size >= this.max) break;
        const s = editSession(sessions, id);
        const messages = s.waiting.splice(0);
        s.events.push(...messages.map((m) => m.id));
        s.status = "active";
        deliveries.set(id, { session: { ...s }, messages });
      }
      return { deliveries, held: ready.length - deliveries.size };
    });
    this.reportWaiting(held);
    // Not awaited: each session runs in the background, so threads proceed in parallel and the
    // next tick isn't held up. `running` tracks them for --max and for batching.
    for (const [id, { session, messages }] of deliveries) this.running.set(id, this.run(id, session, messages));
  }

  /** One agent run for a session: start it with the prompt, or resume it with just the new messages. */
  private async run(id: string, session: Session, messages: WaitingMessage[]): Promise<void> {
    const short = id.slice(0, 8);
    const what = `${session.keys.join(", ") || "new thread"} (${messages.length} message${messages.length === 1 ? "" : "s"})`;
    this.ctx.out(`${session.started ? "resumed" : "started"} ${short} for ${what}`);

    const prompt = this.prompts.get(session.bot_id)!;
    const message = (session.started ? "" : prompt + "\n\n") + describeMessages(messages);
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

  /** Says how many sessions are held back by --max, only when that number changes. */
  private reportWaiting(held: number): void {
    if (held === this.queued) return;
    this.queued = held;
    if (held) this.ctx.out(dim(`${held} session(s) waiting: ${this.max} sessions are already running.`));
  }
}

function describeMessages(messages: WaitingMessage[]): string {
  const lines = messages.map(
    (m) => `- ${m.id}  ${m.type}  ${m.key ?? ""}  (read: loopway events get ${m.inbox_id} ${m.id} --data)`,
  );
  return `New messages for this thread:\n${lines.join("\n")}`;
}
