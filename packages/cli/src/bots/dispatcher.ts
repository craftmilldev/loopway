import { readFile } from "node:fs/promises";
import {
  ApiError,
  type Assignment,
  type Bot,
  type Lease,
  type LoopwayClient,
  type Message,
  type Thread,
  type ThreadMessage,
  type ThreadPatch,
} from "../client.js";
import { loadGithubBot } from "../config.js";
import { UsageError, type Context } from "../context.js";
import { clock, dim } from "../format.js";
import { startMcpServer, type McpServer, type McpTool } from "../mcp.js";
import { runHarness, type RunAgent, type RunOutcome } from "@loopway/harnesses";
import { botEnv } from "./github.js";
import { checkRules, route, type BotRule } from "@loopway/rules";
import { sessionTools } from "./tools.js";
import { sessionLogPath } from "./transcript.js";

export interface ThreadsOptions {
  max?: number;
  interval?: number;
  /** How long each bot lease lasts; it's renewed every tick. */
  ttl?: number;
  /**
   * false runs without bot leases (see setLeaseBots): the runner only delivers to the threads it already owns.
   * True unless this is false.
   */
  leaseBots?: boolean;
}

interface StartOptions extends ThreadsOptions {
  runnerId: string;
  /** Ids of bots already reported as not ready, so a new bot is announced only once. */
  seen?: string[];
  /** Bot name → the absolute directory its sessions run in (see loadWorkdirs); the others run in this process's. */
  workdirs?: Map<string, string>;
}

/**
 * The lease TTL is short on purpose: the bots of a runner that died without releasing them (killed,
 * crashed, power lost) come free in well under a minute instead of blocking the next runner.
 */
/** API-error retries per session before giving up, and the first backoff, which doubles each time. */
export const API_ERROR_RETRIES = 3;
export const API_ERROR_BACKOFF_MS = 60_000;
/** Network errors (offline, DNS) aren't capped, since they clear on their own; their backoff stops doubling here. */
export const NETWORK_ERROR_MAX_BACKOFF_MS = 10 * 60_000;

/** Whether an API error says the machine couldn't reach the API, rather than the API failing. */
export function isNetworkError(error: string): boolean {
  return /Can't reach the API server|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(error);
}

export const DEFAULTS = { max: 3, interval: 5, ttl: 30 };

/** The longest the runner waits between polls once nothing has happened for a while. */
export const MAX_POLL_INTERVAL = 60;

/** A bot another runner holds the lease on. */
export interface SkippedBot extends Bot {
  /** When that lease expires, if the server said. */
  leased_until?: string;
  /** The name of the runner that holds it, if the server said. */
  held_by?: string;
}

/** A message waiting on one of this runner's threads. The same message can wait on a thread of each bot. */
export interface WaitingMessage extends ThreadMessage {
  thread_id: string;
  bot_name: string;
}

/** What a dispatcher is doing right now, for the TUI. */
export interface DispatcherState {
  /**
   * The bots this runner holds a lease on, the ones it skipped because another runner holds theirs, and the rest:
   * ones it hasn't tried to lease, as with bot leases off.
   */
  bots: { held: Bot[]; skipped: SkippedBot[]; unleased: Bot[] };
  /** Whether this runner takes bot leases; without them it only delivers to its own threads. */
  leaseBots: boolean;
  /** Messages assigned to this runner's threads but not delivered yet, oldest first. */
  waiting: WaitingMessage[];
  /** Every thread of the bots, this runner's and other runners', by id. */
  threads: Record<string, Thread>;
  /** This runner's id, and the names of the account's runners, to say whose a thread is. */
  runnerId: string;
  runners: Record<string, string>;
  /** The runners no process holds the lease of; their active threads are stranded. */
  offline: ReadonlySet<string>;
  /** Threads with a run in flight. */
  running: ReadonlySet<string>;
}

/**
 * Runs the bots of this account: hands their messages to Claude Code sessions, one per thread. Threads
 * live on the server and belong to the runner that claimed them; this runner only touches its own.
 * Each tick, per bot it holds a lease on:
 *
 * 1. reads the messages after the bot's cursor,
 * 2. routes each one to a thread with the bot's stored rules (see `route` in rules.ts), and hands them to the server
 *    with `assign`, which moves the cursor past them; threads that creates are claimed right away;
 *
 * then starts or resumes, in the background, every thread of this runner that has waiting messages and no run
 * in flight, as far as --max allows.
 *
 * Delivered messages are context for the session, not tasks it has to mark done; the inbox's messages
 * are left alone. Sessions talk back through the MCP tools in tools.ts, and `end` is what finishes
 * a thread.
 */
export class Dispatcher {
  /** Thread id → its run in flight. */
  private readonly running = new Map<string, Promise<void>>();
  /** Thread id → the bot it belongs to, for the MCP tools of the runs in flight. */
  private readonly threadBots = new Map<string, string>();
  /** Bot id → the lease this runner holds. */
  private readonly leases = new Map<string, Lease>();
  /** Bots skipped last tick because another runner holds their lease → when that lease expires, if known. */
  private readonly skipped = new Map<string, string | undefined>();
  /** Bots whose threads this runner has already checked for runs cut off by a previous runner. */
  private readonly repaired = new Set<string>();
  /** Bots whose unclaimed threads this runner has already claimed, which it does once it holds their lease. */
  private readonly claimed = new Set<string>();
  private leaseBots: boolean;
  /** Ids of the bots not running that were already reported, so each is announced once. */
  private readonly seen = new Set<string>();
  private closing?: Promise<void>;
  private draining = false;
  private readonly max: number;
  private readonly ttl: number;
  /** This machine's runner id (see ensureRunner), recorded on the bot leases it takes. */
  private readonly runnerId: string;
  /** Bot name → the directory its sessions run in, for the bots loopway.json names. */
  private readonly workdirs: Map<string, string>;
  /** This process's lease on its runner, so no other process uses the same runner id. Thread writes take its token. */
  private runnerLease?: Lease;
  private readonly runAgent: RunAgent;
  private readonly dir: string;
  private queued = 0;
  /** While a run says the account hit its usage limit: when the limit resets (ms), until which nothing is delivered. */
  private limitedUntil = 0;
  /** Bot id → the newest version that was ignored because its rules don't parse. */
  private readonly rejected = new Map<string, number>();
  /** Thread id → consecutive API-error retries so far, and when the next one may start (ms). */
  private readonly errored = new Map<string, { retries: number; after: number }>();
  /** Whether a run has exited since the last tick started, and who to tell when one does. */
  private freed = false;
  private onFreed?: () => void;
  /** When the runner last had something happen: messages read, a session started or a run exited (ms). */
  private lastActivity = Date.now();

  /**
   * `bots` must all have a prompt version with rules, and `runnerId` is this machine's runner
   * (see ensureRunner). Takes the runner's lease.
   */
  static async start(ctx: Context, client: LoopwayClient, bots: Bot[], opts: StartOptions): Promise<Dispatcher> {
    const rules = new Map<string, BotRule[]>();
    const prompts = new Map<string, string>();
    for (const bot of bots) {
      if (!bot.prompt_version?.rules) throw new Error(`Bot ${bot.name} has no prompt version with rules.`);
      checkRules(bot.prompt_version.rules);
      rules.set(bot.id, bot.prompt_version.rules);
      prompts.set(bot.id, bot.prompt_version.prompt);
    }
    // With a GitHub bot configured, sessions comment, push and commit as it; otherwise as the user.
    const gh = await loadGithubBot(ctx.configDir, ctx.env);
    // Their `loopway` calls never update the CLI: only this process does, once the sessions have finished.
    const env = { ...(gh ? botEnv(ctx.env, gh) : ctx.env), LOOPWAY_NO_UPDATE: "1" };
    // The tools reach the dispatcher once it exists; no session calls one before then.
    const later: { dispatcher?: Dispatcher } = {};
    const tools = sessionTools(
      {
        get: (id) => later.dispatcher!.getThread(id),
        patch: (id, patch) => later.dispatcher!.patchThread(id, patch),
      },
      ctx.metrics,
    );
    const mcp = await startMcpServer("loopway", tools);
    const dispatcher = (later.dispatcher = new Dispatcher(ctx, client, bots, rules, prompts, opts, mcp, tools, env));
    try {
      await dispatcher.leaseRunner();
    } catch (err) {
      await mcp.close();
      throw err;
    }
    return dispatcher;
  }

  private constructor(
    private readonly ctx: Context,
    private readonly client: LoopwayClient,
    private readonly bots: Bot[],
    private readonly rules: Map<string, BotRule[]>,
    private readonly prompts: Map<string, string>,
    opts: StartOptions,
    private readonly mcp: McpServer,
    private readonly tools: McpTool[],
    /** The environment each session runs with. */
    private readonly env: NodeJS.ProcessEnv,
  ) {
    for (const id of opts.seen ?? []) this.seen.add(id);
    this.max = opts.max ?? DEFAULTS.max;
    this.leaseBots = opts.leaseBots !== false;
    this.ttl = opts.ttl ?? DEFAULTS.ttl;
    this.runnerId = opts.runnerId;
    this.workdirs = opts.workdirs ?? new Map<string, string>();
    this.runAgent = ctx.runAgent ?? runHarness;
    this.dir = ctx.configDir;
  }

  /** Stops taking on work: ticks only renew the leases, so the sessions in flight can finish. Not undone. */
  drain(): void {
    this.draining = true;
  }

  /**
   * Turns bot leases off or on. Off, the next tick gives back the leases this runner holds and it stops taking
   * them, so it no longer reads the bots' messages or starts threads: the runner that leases a bot next routes
   * them, to this runner's threads too. This runner keeps delivering to its own threads, as delivery needs only
   * its runner lease. On, it takes the leases again from the next tick.
   */
  setLeaseBots(on: boolean): void {
    if (on === this.leaseBots) return;
    this.leaseBots = on;
    this.ctx.out(
      on ? "taking bot leases again" : "giving back the bot leases: only delivering to this runner's threads now",
    );
  }

  /** Whether any session is running. */
  get busy(): boolean {
    return this.running.size > 0;
  }

  /** Milliseconds since the runner last had something to do; polling slows down as this grows. */
  idleMs(): number {
    return Date.now() - this.lastActivity;
  }

  async tick(): Promise<void> {
    this.freed = false;
    await this.leaseRunner();
    if (!this.draining)
      await this.syncBots().catch((err) =>
        this.ctx.out(`error: looking for new bots: ${err instanceof Error ? err.message : String(err)}`),
      );
    // A copy, as a bot the server no longer knows is dropped from `this.bots` as it goes.
    for (const bot of [...this.bots]) {
      try {
        const leased = this.leaseBots ? await this.lease(bot) : (await this.release(bot), false);
        if (this.draining) continue;
        // This runner's own threads are repaired once whether or not it holds the bot; unclaimed ones are claimed
        // only by the runner that holds it.
        const repair = !this.repaired.has(bot.id);
        const claim = leased && !this.claimed.has(bot.id);
        if (leased) await this.refreshVersion(bot);
        if (repair || claim) {
          await this.reconcile(bot, { repair, claim });
          if (repair) this.repaired.add(bot.id);
          if (claim) this.claimed.add(bot.id);
        }
        if (leased) await this.poll(bot);
      } catch (err) {
        if (this.dropIfGone(bot, err)) continue;
        // One bot's trouble (a flaky network, say) shouldn't stop the others; try again next tick.
        this.ctx.out(`error: bot ${bot.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!this.draining) await this.deliverAll();
  }

  /**
   * Starts running the bots created since the last tick, so a new bot needs no restart, and stops running the ones
   * deleted since. One without a prompt and rules yet is reported once and checked again each tick; one whose rules
   * don't parse is reported once per version. Sessions already running for a deleted bot's threads are left to finish.
   */
  private async syncBots(): Promise<void> {
    const listed = await this.client.listBots();
    const ids = new Set(listed.map((b) => b.id));
    for (const bot of [...this.bots]) if (!ids.has(bot.id)) this.dropBot(bot, "deleted");
    for (const bot of listed) {
      if (this.rules.has(bot.id)) continue;
      const version = bot.prompt_version;
      if (!version?.rules) {
        if (this.seen.has(bot.id)) continue;
        this.seen.add(bot.id);
        this.ctx.out(`Skipping bot ${bot.name}: it has no prompt and rules yet. Set them with \`loopway bots edit\`.`);
        void this.ctx.metrics?.capture("bot_skipped", { reason: "no_version" });
        continue;
      }
      if (this.rejected.get(bot.id) === version.version) continue;
      try {
        checkRules(version.rules);
      } catch (err) {
        this.rejected.set(bot.id, version.version);
        this.ctx.out(`bot ${bot.name}: not running it: ${err instanceof Error ? err.message : String(err)}`);
        void this.ctx.metrics?.capture("bot_skipped", { reason: "invalid_rules" });
        continue;
      }
      this.rules.set(bot.id, version.rules);
      this.prompts.set(bot.id, version.prompt);
      this.bots.push(bot);
      this.ctx.out(`bot ${bot.name}: found, now running it`);
      void this.ctx.metrics?.capture("bot_picked_up");
    }
  }

  /** Stops running a bot the server no longer has, forgetting everything the runner kept about it. */
  private dropBot(bot: Bot, reason: "deleted" | "not_found"): void {
    const i = this.bots.indexOf(bot);
    if (i < 0) return;
    this.bots.splice(i, 1);
    for (const m of [this.rules, this.prompts, this.leases, this.skipped, this.rejected]) m.delete(bot.id);
    for (const set of [this.repaired, this.claimed, this.seen]) set.delete(bot.id);
    this.ctx.out(`bot ${bot.name}: deleted, no longer running it`);
    void this.ctx.metrics?.capture("bot_removed", { reason });
  }

  /** Drops the bot when `err` says the server doesn't have it (anymore); returns whether it did. */
  private dropIfGone(bot: Bot, err: unknown): boolean {
    if (!(err instanceof ApiError && err.code === "not_found")) return false;
    this.dropBot(bot, "not_found");
    return true;
  }

  /**
   * Switches the bot to its newest version when it has a new one: its rules route the messages from now on, and its
   * prompt starts the threads that start from now on. A version whose rules don't parse is reported once and ignored,
   * so the previous one keeps running.
   */
  private async refreshVersion(bot: Bot): Promise<void> {
    const version = (await this.client.getBot(bot.id)).prompt_version;
    if (!version || version.version === bot.prompt_version?.version || version.version === this.rejected.get(bot.id))
      return;
    try {
      if (!version.rules) throw new Error("it has no rules");
      checkRules(version.rules);
    } catch (err) {
      this.rejected.set(bot.id, version.version);
      this.ctx.out(
        `bot ${bot.name}: ignoring version ${version.version}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.rules.set(bot.id, version.rules);
    this.prompts.set(bot.id, version.prompt);
    bot.prompt_version = version;
    this.ctx.out(`bot ${bot.name}: now on version ${version.version}`);
  }

  /** The threads of this runner's bots, and the messages waiting on this runner's, as of now. */
  async state(): Promise<DispatcherState> {
    const threads: Record<string, Thread> = {};
    for (const bot of this.bots) for (const t of await this.client.listThreads(bot.id, "all")) threads[t.id] = t;
    const all = await this.client.listRunners();
    const runners = Object.fromEntries(all.map((r) => [r.id, r.name]));
    const names = new Map(this.bots.map((b) => [b.id, b.name]));
    const waiting = Object.values(threads)
      .filter((t) => t.runner_id === this.runnerId)
      .flatMap((t) => t.waiting.map((m) => ({ ...m, thread_id: t.id, bot_name: names.get(t.bot_id) ?? "" })))
      .sort((a, b) => a.id.localeCompare(b.id) || a.thread_id.localeCompare(b.thread_id));
    return {
      leaseBots: this.leaseBots,
      bots: {
        held: this.bots.filter((b) => this.leases.has(b.id)),
        skipped: this.bots
          .filter((b) => this.skipped.has(b.id))
          .map((b) => ({
            ...b,
            leased_until: this.skipped.get(b.id),
            held_by: all.find((r) => r.id !== this.runnerId && r.bots.some((x) => x.id === b.id))?.name,
          })),
        unleased: this.bots.filter((b) => !this.leases.has(b.id) && !this.skipped.has(b.id)),
      },
      waiting,
      threads,
      runnerId: this.runnerId,
      runners,
      offline: new Set(all.filter((r) => !r.leased_until).map((r) => r.id)),
      running: new Set(this.running.keys()),
    };
  }

  /**
   * Calls one of the session tools (see tools.ts) for a run in flight, as its session does over MCP. For
   * runAgent overrides whose sessions get their tools another way than the MCP URL.
   */
  callTool(threadId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return Promise.reject(new Error(`Unknown tool ${name}`));
    return tool.call(threadId, args);
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
    if (this.runnerLease) await this.client.releaseRunner(this.runnerId, this.runnerLease.token).catch(() => {});
    await this.mcp.close();
  }

  /** Takes or renews the lease on this machine's runner. Fails if another process holds it. */
  private async leaseRunner(): Promise<void> {
    try {
      const { lease } = await this.client.leaseRunner(this.runnerId, {
        ttl_seconds: this.ttl,
        lease_token: this.runnerLease?.token,
      });
      this.runnerLease = lease;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "runner_leased")) throw err;
      const until = leasedUntil(err);
      // A UsageError, so the CLI prints just the message rather than a stack trace.
      throw new UsageError(
        `This machine's runner is already in use by another \`loopway bots run\`${until ? ` (its lease lasts until ${clock(until)})` : ""}. Stop that one, or wait for its lease to end.`,
        { cause: err },
      );
    }
  }

  /** Gives back the bot's lease, if this runner holds it. */
  private async release(bot: Bot): Promise<void> {
    this.skipped.delete(bot.id);
    const lease = this.leases.get(bot.id);
    if (!lease) return;
    this.leases.delete(bot.id);
    // One that expired or was taken over is gone already.
    await this.client.releaseBot(bot.id, lease.token).catch(() => {});
    this.ctx.out(`bot ${bot.name}: lease given back`);
  }

  /** Takes or renews the bot's lease. False, with a log line the first time, if another runner holds it. */
  private async lease(bot: Bot): Promise<boolean> {
    try {
      const { lease } = await this.client.leaseBot(bot.id, {
        ttl_seconds: this.ttl,
        lease_token: this.leases.get(bot.id)?.token,
        runner_id: this.runnerId,
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

  /**
   * Picks up the threads of this runner a previous runner left mid-run (it died, was restarted, or the machine
   * slept). The session exists in Claude Code once its log has an `init` record, so the thread is marked started;
   * the messages it was handed but never finished go back to waiting, or, for runs from before those were
   * recorded, the session is told to carry on (`repair`, done once per bot on this runner's first tick, so no run
   * of this runner is in flight). Threads a runner created with `assign` but died before claiming are claimed
   * too, if no session ever ran for them (`claim`, once per bot, when this runner first holds its lease).
   */
  private async reconcile(bot: Bot, { repair, claim }: { repair: boolean; claim: boolean }): Promise<void> {
    let repaired = 0;
    for (const t of await this.client.listThreads(bot.id, "pending", false)) {
      if (!t.runner_id && !t.started) {
        if (claim) await this.client.claimThread(bot.id, t.id, this.token());
        continue;
      }
      if (!repair || t.runner_id !== this.runnerId || t.status !== "active") continue;
      const log = await this.readLog(t.id);
      if (!log) continue;
      const last = log.trimEnd().split("\n").at(-1) ?? "";
      const cutOff = !last.includes('"type":"result"');
      const started = !t.started && log.includes('"subtype":"init"');
      const inflight = t.inflight.length > 0;
      if (!started && !(cutOff && (inflight || !t.waiting.length))) continue;
      const patch: ThreadPatch = {};
      if (started) patch.started = true;
      if (inflight) await this.client.finishThread(bot.id, t.id, this.token(), { requeue: true });
      else if (cutOff && !t.waiting.length) patch.interrupted = true;
      if (Object.keys(patch).length)
        await this.client.patchThread(bot.id, t.id, { ...patch, lease_token: this.token() });
      repaired++;
    }
    if (repaired) this.ctx.out(dim(`Bot ${bot.name}: picked up ${repaired} thread(s) a previous runner cut off.`));
  }

  /** Reads the bot's messages until there are none, assigning each page to threads and moving the cursor past it. */
  private async poll(bot: Bot): Promise<void> {
    while (this.leases.has(bot.id)) {
      const messages = await this.client.botMessages(bot.id, { limit: 100 });
      if (!messages.length) return;
      this.lastActivity = Date.now();
      await this.assign(bot, messages);
    }
  }

  /**
   * Routes each message to a thread (an existing one, or a new one) and has the server assign the page, which also
   * moves the cursor past it. Messages already assigned are skipped by the server. The threads it creates are
   * claimed by this runner right away.
   */
  private async assign(bot: Bot, messages: Message[]): Promise<void> {
    const rules = this.rules.get(bot.id)!;
    const threads = await this.client.listThreads(bot.id, "all");
    // Who holds each subject, kept up to date as the page is routed so a later message sees an earlier one's threads.
    const held = new Map(threads.flatMap((t) => t.subjects.map((s) => [s, t.id] as const)));
    const known = new Set(threads.map((t) => t.id));
    const created: string[] = [];
    const assignments: Assignment[] = [];
    for (const m of messages) {
      const routed = route(rules, held, m, { botId: bot.id, threads: known });
      if (!routed) continue;
      for (const s of routed.add_subjects) held.set(s, routed.thread_id);
      if (!known.has(routed.thread_id)) {
        known.add(routed.thread_id);
        created.push(routed.thread_id);
      }
      assignments.push({
        message_id: m.id,
        thread_id: routed.thread_id,
        ...(routed.add_subjects.length ? { add_subjects: routed.add_subjects } : {}),
        ...(routed.key ? { subject: routed.key } : {}),
        ...(routed.author_kind ? { author_kind: routed.author_kind } : {}),
      });
    }
    await this.client.assign(bot.id, {
      lease_token: this.leases.get(bot.id)!.token,
      cursor: messages.at(-1)!.seq,
      assignments,
    });
    for (const id of created) await this.client.claimThread(bot.id, id, this.token());
  }

  /**
   * Starts or resumes every thread of this runner with waiting messages and no run in flight, oldest first, while
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
    // A thread the limit stopped is ready too, with nothing new to deliver; ordering puts it first.
    const ready: Thread[] = [];
    for (const bot of [...this.bots]) {
      try {
        for (const t of await this.client.listThreads(bot.id, "pending", false)) {
          if (t.runner_id !== this.runnerId || running.has(t.id)) continue;
          if (!(t.waiting.length || t.limited || t.interrupted)) continue;
          if ((this.errored.get(t.id)?.after ?? 0) > Date.now()) continue;
          ready.push(t);
        }
      } catch (err) {
        // One bot's trouble shouldn't stop delivery to the others.
        if (this.dropIfGone(bot, err)) continue;
        this.ctx.out(`error: bot ${bot.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    ready.sort((a, b) => (a.waiting[0]?.id ?? "").localeCompare(b.waiting[0]?.id ?? ""));

    const deliveries: { thread: Thread; messages: ThreadMessage[] }[] = [];
    let failed = 0;
    for (const thread of ready) {
      if (running.size + deliveries.length >= this.max) break;
      try {
        const messages = await this.client.deliverThread(thread.bot_id, thread.id, this.token());
        if (thread.limited || thread.interrupted)
          await this.client.patchThread(thread.bot_id, thread.id, {
            limited: false,
            interrupted: false,
            lease_token: this.token(),
          });
        deliveries.push({ thread, messages });
      } catch (err) {
        failed++;
        this.ctx.out(`error: thread ${thread.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.reportWaiting(ready.length - deliveries.length - failed);
    // Not awaited: each session runs in the background, so threads proceed in parallel and the
    // next tick isn't held up. `running` tracks them for --max and for batching.
    if (deliveries.length) this.lastActivity = Date.now();
    for (const { thread, messages } of deliveries) this.running.set(thread.id, this.run(thread, messages));
  }

  /**
   * One agent run for a thread: start it with the prompt, or resume it with just the new messages.
   * A session the usage limit stopped is told to carry on, as its last messages are already in it.
   * `thread` is as it was before the delivery, so its flags say how the last run ended.
   */
  private async run(thread: Thread, messages: ThreadMessage[]): Promise<void> {
    const id = thread.id;
    this.threadBots.set(id, thread.bot_id);
    const short = id.slice(0, 8);
    const count = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
    const after = thread.limited ? "after the usage limit, " : thread.interrupted ? "after an interruption, " : "";
    const what = `${thread.subjects.join(", ") || "new thread"} (${after}${count})`;
    this.ctx.out(`${thread.started ? "resumed" : "started"} ${short} for ${what}`);

    const prompt = this.prompts.get(thread.bot_id)!;
    const bot = this.bots.find((b) => b.id === thread.bot_id)!;
    // A script bot's prompt is its command (see ScriptHarness), not text to put in front of the messages.
    const parts = [
      !thread.started && bot.harness !== "script" && prompt,
      thread.limited && RESUME_AFTER_LIMIT,
      thread.interrupted && RESUME_AFTER_INTERRUPT,
      messages.length > 0 && describeMessages(messages),
    ];
    const message = parts.filter((p): p is string => typeof p === "string").join("\n\n");
    // A bot with its own directory runs there, and may still work in the runner's (the workspace it started from).
    const cwd = this.workdirs.get(bot.name);
    const own = cwd !== undefined && cwd !== process.cwd();
    const attempt = (resume: boolean) =>
      this.runAgent({
        harness: bot.harness,
        sessionId: id,
        resume,
        message,
        model: bot.model,
        ...(bot.harness === "script" ? { script: prompt } : {}),
        logPath: sessionLogPath(this.dir, id),
        mcpUrl: this.mcp.urlFor(id),
        env: this.env,
        ...(own ? { cwd, addDirs: [process.cwd()] } : {}),
        // The session exists from here on, even if this run is cut off before it finishes.
        onStarted: () => {
          this.patchThread(id, { started: true }).catch(() => {});
        },
      });
    let outcome: RunOutcome;
    try {
      outcome = await attempt(thread.started);
      // A session an earlier run created but we never recorded: pick it up instead of failing.
      if (!thread.started && outcome.code !== 0 && (await this.readLog(id)).slice(-2000).includes("already in use")) {
        outcome = await attempt(true);
      }
    } catch (err) {
      outcome = { code: -1, delivered: false };
      this.ctx.out(`error: ${short} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { code, delivered, limitedUntil, apiError, ended: done } = outcome;
    // The usage limit has its own wait; an API error gets a backoff per thread, and a cap so a permanent one can't loop.
    const prior = this.errored.get(id)?.retries ?? 0;
    const retry = !limitedUntil && !!apiError && (isNetworkError(apiError) || prior < API_ERROR_RETRIES);
    const requeue = !!limitedUntil || retry;
    let ended = false;
    try {
      // Messages that reached the session before the run was cut short stay delivered, and the thread is flagged to
      // resume it once the wait is over. Ones that didn't are delivered again then.
      await this.client.finishThread(thread.bot_id, id, this.token(), { requeue: requeue && !delivered });
      const patch: ThreadPatch = { started: true };
      if (requeue && delivered) patch[limitedUntil ? "limited" : "interrupted"] = true;
      if (done) patch.status = "ended";
      ended = (await this.patchThread(id, patch)).status === "ended";
    } catch (err) {
      // The messages stay inflight; the next runner to start picks them up (see reconcile).
      this.ctx.out(`error: ${short} couldn't record its run: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Why the session stopped, so the metrics show how often each stop happens.
    const stop = limitedUntil
      ? "usage_limit"
      : retry
        ? "api_error_retry"
        : apiError
          ? "api_error_gave_up"
          : code !== 0
            ? "failed"
            : ended
              ? "ended"
              : "finished";
    void this.ctx.metrics?.capture("bot_session_stopped", {
      stop,
      harness: bot.harness,
      exit_code: code,
      resumed: thread.started,
      messages: messages.length,
    });
    if (limitedUntil) {
      this.limitedUntil = Math.max(this.limitedUntil, limitedUntil);
      this.ctx.out(`${short} hit the usage limit; retrying sessions after ${new Date(limitedUntil).toLocaleString()}`);
    } else if (retry) {
      const network = isNetworkError(apiError);
      const wait = Math.min(API_ERROR_BACKOFF_MS * 2 ** prior, network ? NETWORK_ERROR_MAX_BACKOFF_MS : Infinity);
      this.errored.set(id, { retries: prior + 1, after: Date.now() + wait });
      const of = network ? "" : `/${API_ERROR_RETRIES}`;
      this.ctx.out(
        `${short} hit an API error (${apiError}); retry ${prior + 1}${of} after ${new Date(Date.now() + wait).toLocaleString()}`,
      );
    } else {
      this.errored.delete(id);
      if (apiError)
        this.ctx.out(`${short} hit an API error (${apiError}); giving up after ${API_ERROR_RETRIES} retries`);
      this.ctx.out(`${short} ${ended ? "ended" : "finished"} (exit ${code})`);
    }
    this.running.delete(id);
    this.threadBots.delete(id);
    this.freed = true;
    this.lastActivity = Date.now();
    this.onFreed?.();
  }

  /** The live token of this runner's lease, which every write to its threads takes. */
  private token(): string {
    return this.runnerLease!.token;
  }

  /** The thread of a run in flight, for the MCP tools. */
  private getThread(id: string): Promise<Thread> {
    return this.client.getThread(this.botOf(id), id);
  }

  /** Changes the thread of a run in flight, for the MCP tools and the run itself. */
  private patchThread(id: string, patch: ThreadPatch): Promise<Thread> {
    return this.client.patchThread(this.botOf(id), id, { ...patch, lease_token: this.token() });
  }

  private botOf(threadId: string): string {
    const bot = this.threadBots.get(threadId);
    if (!bot) throw new Error("This thread has no run in flight.");
    return bot;
  }

  /** Says how many sessions are held back by --max, only when that number changes. */
  private reportWaiting(held: number): void {
    if (held === this.queued) return;
    this.queued = held;
    if (held) this.ctx.out(dim(`${held} session(s) waiting: ${this.max} sessions are already running.`));
  }
}

/** When the lease a 409 `leased` ran into expires, if the server said. */
function leasedUntil(err: ApiError): string | undefined {
  const details = err.details as { expires_at?: unknown } | undefined;
  return typeof details?.expires_at === "string" ? details.expires_at : undefined;
}

const RESUME_AFTER_INTERRUPT =
  "Your last run was cut off before it finished (the runner stopped, or the API failed). Carry on from wherever you got to, and check the thread's latest messages on GitHub for anything you missed.";

const RESUME_AFTER_LIMIT =
  "Your last run stopped because the account hit its usage limit. The limit has reset: carry on with the messages you were given, from wherever you got to.";

function describeMessages(messages: ThreadMessage[]): string {
  const lines = messages.map(
    (m) => `- ${m.id}  ${m.type}  ${m.subject ?? ""}  (read: loopway messages get ${m.inbox_id} ${m.id} --data)`,
  );
  return `New messages for this thread:\n${lines.join("\n")}`;
}
