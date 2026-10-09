import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ApiError, type Bot, type Event, type Lease, type LoopwayClient } from "../client.js";
import { loadGithubBot } from "../config.js";
import type { Context } from "../context.js";
import { clock, dim } from "../format.js";
import { startMcpServer, type McpServer } from "../mcp.js";
import { spawnClaude, type RunAgent, type RunOutcome } from "./agent.js";
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

/**
 * The lease TTL is short on purpose: the bots of a runner that died without releasing them (killed,
 * crashed, power lost) come free in well under a minute instead of blocking the next runner.
 */
export const DEFAULTS = { max: 3, interval: 5, ttl: 30 };

/** A bot another runner holds the lease on. */
export interface SkippedBot extends Bot {
  /** When that lease expires, if the server said. */
  leased_until?: string;
}

/** What a dispatcher is doing right now, for the TUI. */
export interface DispatcherState {
  /** The bots this runner holds a lease on, and the ones it skipped because another runner holds theirs. */
  bots: { held: Bot[]; skipped: SkippedBot[] };
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
  /** Bots skipped last tick because another runner holds their lease → when that lease expires, if known. */
  private readonly skipped = new Map<string, string | undefined>();
  private closing?: Promise<void>;
  private readonly max: number;
  private readonly ttl: number;
  private readonly runAgent: RunAgent;
  private readonly dir: string;
  private queued = 0;
  /** While a run says the account hit its usage limit: when the limit resets (ms), until which nothing is delivered. */
  private limitedUntil = 0;
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
        skipped: this.bots
          .filter((b) => this.skipped.has(b.id))
          .map((b) => ({ ...b, leased_until: this.skipped.get(b.id) })),
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

  /**
   * Releases the bot leases, so the next runner needn't wait out the TTL, and stops the MCP server.
   * Closing again, as a second Ctrl-C does, joins the close in progress.
   */
  close(): Promise<void> {
    return (this.closing ??= this.doClose());
  }

  private async doClose(): Promise<void> {
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
      const until = leasedUntil(err);
      if (!this.skipped.has(bot.id)) {
        const when = until ? ` until ${clock(until)}` : "";
        this.ctx.out(`bot ${bot.name} is leased by another runner${when}; skipping it until that lease ends.`);
      }
      this.skipped.set(bot.id, until);
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

  /**
   * Starts or resumes every session with waiting messages and no run in flight, oldest first, while
   * --max allows. Delivers nothing while the usage limit a run hit hasn't reset yet; messages keep
   * queueing up and go out on the first tick after it does.
   */
  private async deliverAll(): Promise<void> {
    if (Date.now() < this.limitedUntil) return;
    if (this.limitedUntil) {
      this.limitedUntil = 0;
      this.ctx.out("usage limit reset; resuming sessions");
    }
    const running = new Set(this.running.keys());
    const { deliveries, held } = await withSessions(this.dir, (sessions) => {
      // A session the limit stopped is ready too, with nothing new to deliver; ordering puts it first.
      const ready = Object.keys(sessions)
        .filter((id) => (sessions[id]!.waiting.length || sessions[id]!.limited) && !running.has(id))
        .filter((id) => this.prompts.has(sessions[id]!.bot_id))
        .sort((a, b) => (sessions[a]!.waiting[0]?.id ?? "").localeCompare(sessions[b]!.waiting[0]?.id ?? ""));
      const deliveries = new Map<string, { session: Session; messages: WaitingMessage[] }>();
      for (const id of ready) {
        if (running.size + deliveries.size >= this.max) break;
        const s = editSession(sessions, id);
        const messages = s.waiting.splice(0);
        s.events.push(...messages.map((m) => m.id));
        s.status = "active";
        deliveries.set(id, { session: { ...s }, messages });
        delete s.limited;
      }
      return { deliveries, held: ready.length - deliveries.size };
    });
    this.reportWaiting(held);
    // Not awaited: each session runs in the background, so threads proceed in parallel and the
    // next tick isn't held up. `running` tracks them for --max and for batching.
    for (const [id, { session, messages }] of deliveries) this.running.set(id, this.run(id, session, messages));
  }

  /**
   * One agent run for a session: start it with the prompt, or resume it with just the new messages.
   * A session the usage limit stopped is told to carry on, as its last messages are already in it.
   */
  private async run(id: string, session: Session, messages: WaitingMessage[]): Promise<void> {
    const short = id.slice(0, 8);
    const count = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
    const what = `${session.keys.join(", ") || "new thread"} (${session.limited ? `after the usage limit, ${count}` : count})`;
    this.ctx.out(`${session.started ? "resumed" : "started"} ${short} for ${what}`);

    const prompt = this.prompts.get(session.bot_id)!;
    const parts = [
      !session.started && prompt,
      session.limited && RESUME_AFTER_LIMIT,
      messages.length > 0 && describeMessages(messages),
    ];
    const message = parts.filter((p): p is string => typeof p === "string").join("\n\n");
    let outcome: RunOutcome;
    try {
      outcome = await this.runAgent({
        sessionId: id,
        resume: session.started,
        message,
        logPath: sessionLogPath(this.dir, id),
        mcpUrl: this.mcp.urlFor(id),
        env: this.env,
      });
    } catch (err) {
      outcome = { code: -1, delivered: false };
      this.ctx.out(`error: ${short} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { code, delivered, limitedUntil, denied } = outcome;
    const ended = await withSessions(this.dir, (sessions) => {
      const s = editSession(sessions, id);
      s.started = true;
      if (limitedUntil && delivered) {
        // The messages reached the session before the limit cut the run short: resume it once the limit resets.
        s.limited = true;
      } else if (limitedUntil) {
        // They didn't: deliver them again once the limit resets.
        const ids = new Set(messages.map((m) => m.id));
        s.events = s.events.filter((e) => !ids.has(e));
        s.waiting.unshift(...messages);
      }
      return s.status === "ended";
    });
    if (limitedUntil) {
      this.limitedUntil = Math.max(this.limitedUntil, limitedUntil);
      this.ctx.out(`${short} hit the usage limit; retrying sessions after ${new Date(limitedUntil).toLocaleString()}`);
    } else this.ctx.out(`${short} ${ended ? "ended" : "finished"} (exit ${code})`);
    if (denied) await this.reportDenials(short, session.keys[0], denied);
    this.running.delete(id);
    this.freed = true;
    this.onFreed?.();
  }

  /** A run with denied tool calls is blocked on permissions, not on an answer: say so in the log and on the thread. */
  private async reportDenials(short: string, key: string | undefined, denied: string[]): Promise<void> {
    this.ctx.out(
      `warning: ${short} had ${denied.length} tool call(s) denied by the permission classifier: ${denied[0]}`,
    );
    if (!key) return;
    const list = denied.slice(0, 10).map((d) => `- \`${d.replaceAll("`", "'")}\``);
    const body = [
      `This thread's last run was blocked on permissions: ${denied.length} tool call(s) were denied, so it may have stopped before finishing.`,
      ...list,
      "To allow them, set `LOOPWAY_ALLOWED_TOOLS` (e.g. `Bash(npm run *)`) for `loopway bots run`; the thread resumes on its next message.",
    ].join("\n");
    try {
      await (this.ctx.comment ?? ghComment)(key, body, this.env);
    } catch (err) {
      this.ctx.out(`error: ${short} couldn't comment on ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Says how many sessions are held back by --max, only when that number changes. */
  private reportWaiting(held: number): void {
    if (held === this.queued) return;
    this.queued = held;
    if (held) this.ctx.out(dim(`${held} session(s) waiting: ${this.max} sessions are already running.`));
  }
}

async function ghComment(key: string, body: string, env: NodeJS.ProcessEnv): Promise<void> {
  const [repo, number] = key.split("#");
  await promisify(execFile)("gh", ["issue", "comment", number!, "--repo", repo!, "--body", body], { env });
}

/** When the lease a 409 `leased` ran into expires, if the server said. */
function leasedUntil(err: ApiError): string | undefined {
  const details = err.details as { expires_at?: unknown } | undefined;
  return typeof details?.expires_at === "string" ? details.expires_at : undefined;
}

const RESUME_AFTER_LIMIT =
  "Your last run stopped because the account hit its usage limit. The limit has reset: carry on with the messages you were given, from wherever you got to.";

function describeMessages(messages: WaitingMessage[]): string {
  const lines = messages.map(
    (m) => `- ${m.id}  ${m.type}  ${m.key ?? ""}  (read: loopway events get ${m.inbox_id} ${m.id} --data)`,
  );
  return `New messages for this thread:\n${lines.join("\n")}`;
}
