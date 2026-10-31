import { readFile } from "node:fs/promises";
import {
  ApiError,
  type Bot,
  type Lease,
  type LoopwayClient,
  type ManagerThread,
  type Runner,
  type Thread,
  type ThreadMessage,
  type ThreadPatch,
} from "../client.js";
import { loadGithubBot } from "../config.js";
import { UsageError, type Context } from "../context.js";
import { clock, dim } from "../format.js";
import { startMcpServer, type McpServer, type McpTool } from "../mcp.js";
import { getHarness, runHarness, type RunAgent, type RunOutcome } from "@loopway/harnesses";
import { botEnv } from "./github.js";
import { sessionTools } from "./tools.js";
import { sessionLogPath } from "./transcript.js";

export interface ThreadsOptions {
  max?: number;
  interval?: number;
  /** How long the runner's lease lasts; it's renewed every tick. */
  ttl?: number;
}

interface StartOptions extends ThreadsOptions {
  runnerId: string;
  /** The slug of the org this runner belongs to: new bots are looked up in that org only. */
  org: string;
  /** Ids of bots already reported as not ready, so a new bot is announced only once. */
  seen?: string[];
  /** Bot name → the absolute directory its sessions run in (see loadWorkdirs); the others run in this process's. */
  workdirs?: Map<string, string>;
}

/** API-error retries per session before giving up, and the first backoff, which doubles each time. */
export const API_ERROR_RETRIES = 3;
export const API_ERROR_BACKOFF_MS = 60_000;
/** Network errors (offline, DNS) aren't capped, since they clear on their own; their backoff stops doubling here. */
export const NETWORK_ERROR_MAX_BACKOFF_MS = 10 * 60_000;

/** Whether an API error says the machine couldn't reach the API, rather than the API failing. */
export function isNetworkError(error: string): boolean {
  return /Can't reach the API server|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(error);
}

/**
 * The lease TTL is short on purpose: a runner that died without releasing its lease (killed, crashed, power lost)
 * comes free soon instead of blocking the next process on the machine. `bots run` raises it to at least three
 * minutes (`defaultTtl`).
 */
export const DEFAULTS = { max: 3, interval: 5, ttl: 30 };

/** The longest the runner waits between polls once nothing has happened for a while. */
export const MAX_POLL_INTERVAL = 60;

/** A message waiting on one of this runner's threads. The same message can wait on a thread of each bot. */
export interface WaitingMessage extends ThreadMessage {
  thread_id: string;
  bot_name: string;
}

/** What a dispatcher is doing right now, for the TUI. */
export interface DispatcherState {
  /** The bots this runner runs. */
  bots: Bot[];
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
  /** Thread id → the harness this runner ran its session on, which can differ from its bot's now. */
  harnesses?: Record<string, string>;
}

/**
 * Runs the bots of this account: hands their messages to agent sessions in the bot's harness, one per thread. The
 * server routes each message to a thread as it arrives; threads belong to the runner that claimed them, and this
 * runner only touches its own. Each tick is one request, the runner's work feed: its own threads with waiting
 * messages and the unowned ones it can claim, which it claims while --max has room. It then starts or resumes, in
 * the background, every thread of this runner that has waiting messages and no run in flight, as far as --max allows.
 * Runners don't contend for bots: any number can run the same ones, and the first to claim a thread owns it.
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
  /** Bots whose threads this runner has already checked for runs cut off by a previous runner. */
  private readonly repaired = new Set<string>();
  /** When this runner last looked for new bots (ms), in the work tick. */
  private syncedAt = 0;
  /** Whether anything reads the thread snapshot (the TUI does); without it the work tick leaves the threads alone. */
  private watching = false;
  /** Ids of the bots not running that were already reported, so each is announced once. */
  private readonly seen = new Set<string>();
  private closing?: Promise<void>;
  private draining = false;
  private readonly max: number;
  private readonly ttl: number;
  /** This machine's runner id (see ensureRunner). */
  private readonly runnerId: string;
  private readonly org: string;
  /** Thread id → the harness and model its session started on, which a resume keeps even if the bot has moved on. */
  private readonly sessions = new Map<string, { harness: Bot["harness"]; model: Bot["model"] }>();
  /** Bot name → the directory its sessions run in, for the bots loopway.json names. */
  private readonly workdirs: Map<string, string>;
  /** This process's lease on its runner, so no other process uses the same runner id. Thread writes take its token. */
  private runnerLease?: Lease;
  private readonly runAgent: RunAgent;
  private readonly dir: string;
  private queued = 0;
  /** While a run says the account hit its usage limit: when the limit resets (ms), until which nothing is delivered. */
  private limitedUntil = 0;
  /** Thread id → consecutive API-error retries so far, and when the next one may start (ms). */
  private readonly errored = new Map<string, { retries: number; after: number }>();
  /** The fetch `refresh()` has in flight. */
  private refreshing?: Promise<void>;
  /** What `state()` shows: filled by `refresh()`, never by `state()` itself. */
  private snapshot: { threads: Record<string, Thread>; runners: Runner[] } = { threads: {}, runners: [] };
  /** Whether a run has exited since the last tick started, and who to tell when one does. */
  private freed = false;
  private onFreed?: () => void;
  /** When the runner last had something happen: messages read, a session started or a run exited (ms). */
  private lastActivity = Date.now();

  /**
   * `bots` must all have a prompt version, and `runnerId` is this machine's runner
   * (see ensureRunner). Takes the runner's lease.
   */
  static async start(ctx: Context, client: LoopwayClient, bots: Bot[], opts: StartOptions): Promise<Dispatcher> {
    const prompts = new Map<string, string>();
    for (const bot of bots) {
      if (!bot.prompt_version) throw new Error(`Bot ${bot.name} has no prompt version.`);
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
      () => later.dispatcher?.markOutdated(),
    );
    const mcp = await startMcpServer("loopway", tools);
    const dispatcher = (later.dispatcher = new Dispatcher(ctx, client, bots, prompts, opts, mcp, tools, env));
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
    private readonly prompts: Map<string, string>,
    opts: StartOptions,
    private readonly mcp: McpServer,
    private readonly tools: McpTool[],
    /** The environment each session runs with. */
    private readonly env: NodeJS.ProcessEnv,
  ) {
    for (const id of opts.seen ?? []) this.seen.add(id);
    this.max = opts.max ?? DEFAULTS.max;
    this.ttl = opts.ttl ?? DEFAULTS.ttl;
    this.runnerId = opts.runnerId;
    this.org = opts.org;
    this.workdirs = opts.workdirs ?? new Map<string, string>();
    this.runAgent = ctx.runAgent ?? runHarness;
    this.dir = ctx.configDir;
  }

  /** Stops taking on work: ticks only renew the runner's lease, so the sessions in flight can finish. Not undone. */
  drain(): void {
    this.draining = true;
  }

  private outdated = false;

  /** Notes that the server turned this CLI away on a request other than a tick, so the runner looks for an update. */
  markOutdated(): void {
    this.outdated = true;
  }

  /** Whether the server has turned this CLI away since the last call. */
  takeOutdated(): boolean {
    const was = this.outdated;
    this.outdated = false;
    return was;
  }

  /** Whether any session is running. */
  get busy(): boolean {
    return this.running.size > 0;
  }

  /** Milliseconds since the runner last had something to do; polling slows down as this grows. */
  idleMs(): number {
    return Date.now() - this.lastActivity;
  }

  /**
   * One tick: renews the runner's lease, then one request says what this runner has to do, so an idle tick makes no
   * per-bot calls. Claims the unowned threads it has room for, then delivers.
   */
  async tick(): Promise<void> {
    this.freed = false;
    await this.leaseRunner();
    if (this.draining) return void (await this.fetchSnapshotOnce());
    let work = await this.fetchWork();
    // The bots this runner runs change rarely; look for new ones about as often as an idle runner polls.
    if (Date.now() - this.syncedAt >= MAX_POLL_INTERVAL * 1000) {
      this.syncedAt = Date.now();
      await this.syncBots().catch((err) =>
        this.ctx.out(`error: looking for new bots: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    // Repairing changes threads (an in-flight message goes back to waiting), so the feed is read again after it.
    let repaired = false;
    for (const bot of [...this.bots]) {
      if (this.repaired.has(bot.id)) continue;
      try {
        await this.reconcile(bot);
        this.repaired.add(bot.id);
        repaired = true;
      } catch (err) {
        if (this.dropIfGone(bot, err)) continue;
        this.ctx.out(`error: bot ${bot.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (repaired) work = await this.fetchWork();
    await this.deliverAll(work);
    if (this.watching) await this.fetchSnapshotOnce();
  }

  /** The work feed for this runner's bots: its threads with waiting messages, and the unowned ones it can claim. */
  private fetchWork(): Promise<Thread[]> {
    return this.client.runnerWork(
      this.runnerId,
      this.token(),
      this.bots.map((b) => b.id),
    );
  }

  /**
   * Re-reads the threads of this runner's bots and the account's runners into the snapshot `state()` returns. Once
   * per tick, and after a send or end from the TUI; a failure leaves the last snapshot in place. Calls that arrive
   * while a fetch is running share it.
   */
  refresh(): Promise<void> {
    this.watching = true;
    return this.fetchSnapshotOnce();
  }

  private fetchSnapshotOnce(): Promise<void> {
    this.refreshing ??= this.fetchSnapshot().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const threads: Record<string, Thread> = {};
      for (const bot of this.bots) for (const t of await this.client.listThreads(bot.id, "all")) threads[t.id] = t;
      this.snapshot = { threads, runners: await this.client.listRunners(this.org) };
    } catch (err) {
      this.ctx.out(`error: refreshing the thread list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Starts running the bots created since the last tick, so a new bot needs no restart, and stops running the ones
   * deleted since. One without a prompt yet is reported once and checked again each time. Sessions already running
   * for a deleted bot's threads are left to finish.
   */
  private async syncBots(): Promise<void> {
    // The runner belongs to one org, so ask for that org's bots only.
    const listed = await this.client.listBots(this.org);
    const ids = new Set(listed.map((b) => b.id));
    for (const bot of [...this.bots]) if (!ids.has(bot.id)) this.dropBot(bot, "deleted");
    for (const bot of listed) {
      if (this.prompts.has(bot.id)) continue;
      const version = bot.prompt_version;
      if (!version) {
        if (this.seen.has(bot.id)) continue;
        this.seen.add(bot.id);
        this.ctx.out(`Skipping bot ${bot.name}: it has no prompt yet. Set one with \`loopway bots edit\`.`);
        void this.ctx.metrics?.capture("bot_skipped", { reason: "no_version" });
        continue;
      }
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
    this.prompts.delete(bot.id);
    for (const set of [this.repaired, this.seen]) set.delete(bot.id);
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
   * Switches the bot to its newest version when it has a new one, so the threads that start from now on use its
   * prompt, harness and model.
   */
  private async refreshVersion(bot: Bot): Promise<void> {
    const fresh = await this.client.getBot(bot.id);
    // Threads that start from now on use the new harness and model; ones already running keep theirs (see run).
    if (fresh.harness !== bot.harness || fresh.model !== bot.model) {
      bot.harness = fresh.harness;
      bot.model = fresh.model;
      this.ctx.out(`bot ${bot.name}: now on harness ${bot.harness} / model ${bot.model}`);
    }
    const version = fresh.prompt_version;
    if (!version || version.version === bot.prompt_version?.version) return;
    this.prompts.set(bot.id, version.prompt);
    bot.prompt_version = version;
    this.ctx.out(`bot ${bot.name}: now on version ${version.version}`);
  }

  /**
   * The threads of this runner's bots, and the messages waiting on this runner's, as of the last refresh. Reads
   * memory only, so the TUI can redraw as often as it likes without calling the server.
   */
  async state(): Promise<DispatcherState> {
    const { threads, runners: all } = this.snapshot;
    const runners = Object.fromEntries(all.map((r) => [r.id, r.name]));
    const names = new Map(this.bots.map((b) => [b.id, b.name]));
    const waiting = Object.values(threads)
      .filter((t) => t.runner_id === this.runnerId)
      .flatMap((t) => t.waiting.map((m) => ({ ...m, thread_id: t.id, bot_name: names.get(t.bot_id) ?? "" })))
      .sort((a, b) => a.id.localeCompare(b.id) || a.thread_id.localeCompare(b.thread_id));
    return {
      bots: [...this.bots],
      waiting,
      threads,
      runnerId: this.runnerId,
      runners,
      offline: new Set(all.filter((r) => !r.leased_until).map((r) => r.id)),
      running: new Set(this.running.keys()),
      harnesses: Object.fromEntries([...this.sessions].map(([id, s]) => [id, s.harness])),
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
   * Releases the runner's lease, so the next process needn't wait out the TTL, and stops the MCP server.
   * Closing again, as a second Ctrl-C does, joins the close in progress.
   */
  close(): Promise<void> {
    return (this.closing ??= this.doClose());
  }

  private async doClose(): Promise<void> {
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

  /**
   * Picks up the threads of this runner a previous runner left mid-run (it died, was restarted, or the machine
   * slept). The session exists in Claude Code once its log has an `init` record, so the thread is marked started;
   * the messages it was handed but never finished go back to waiting, or, for runs from before those were
   * recorded, the session is told to carry on. Done once per bot on this runner's first tick, so no run of this
   * runner is in flight.
   */
  private async reconcile(bot: Bot): Promise<void> {
    let repaired = 0;
    for (const t of await this.client.listThreads(bot.id, "pending", false)) {
      if (t.runner_id !== this.runnerId || t.status !== "active") continue;
      const log = await this.readLog(t.id);
      const inflight = t.inflight.length > 0;
      // A script that died before writing anything leaves no transcript, but its messages are still inflight.
      if (!log && !inflight) continue;
      const harness = this.sessions.get(t.id)?.harness ?? bot.harness;
      const cutOff = !getHarness(harness).runFinished(log);
      const started = !t.started && log.includes('"subtype":"init"');
      if (!started && !(cutOff && (inflight || !t.waiting.length))) continue;
      const patch: ThreadPatch = {};
      if (started) patch.started = true;
      if (inflight) {
        await this.client.finishThread(bot.id, t.id, this.token(), { requeue: true });
        void this.ctx.metrics?.capture("thread_inflight_requeued", { transcript: log ? "present" : "empty" });
      } else if (cutOff && !t.waiting.length) patch.interrupted = true;
      if (Object.keys(patch).length)
        await this.client.patchThread(bot.id, t.id, { ...patch, lease_token: this.token() });
      repaired++;
    }
    if (repaired) this.ctx.out(dim(`Bot ${bot.name}: picked up ${repaired} thread(s) a previous runner cut off.`));
  }

  /**
   * Claims the feed's unowned threads, oldest first, into `ready` while there is room under --max. First claim wins:
   * a thread another runner took first is skipped, and so is one this runner can't claim right now.
   */
  private async claimUnowned(work: Thread[], ready: Thread[], running: number): Promise<void> {
    const open = work
      .filter((t) => !t.runner_id)
      .sort((a, b) => (a.waiting[0]?.id ?? "").localeCompare(b.waiting[0]?.id ?? ""));
    for (const t of open) {
      if (running + ready.length >= this.max) return;
      try {
        ready.push(await this.client.claimThread(t.bot_id, t.id, this.token()));
        void this.ctx.metrics?.capture("thread_claimed");
      } catch (err) {
        if (err instanceof ApiError && err.code === "thread_owned") {
          void this.ctx.metrics?.capture("thread_claim_lost");
          continue;
        }
        this.ctx.out(`error: thread ${t.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Starts or resumes every thread of this runner with waiting messages and no run in flight, oldest first, while
   * --max allows. Delivers nothing while the usage limit a run hit hasn't reset yet; messages keep
   * queueing up and go out on the first tick after it does. The threads come from the work feed, and the unowned ones
   * in it are claimed first, as many as there is room for.
   */
  private async deliverAll(work: Thread[]): Promise<void> {
    if (Date.now() < this.limitedUntil) return;
    if (this.limitedUntil) {
      this.limitedUntil = 0;
      this.ctx.out("usage limit reset; resuming sessions");
    }
    const running = new Set(this.running.keys());
    // A thread the limit stopped is ready too, with nothing new to deliver; ordering puts it first.
    const ready: Thread[] = [];
    const isReady = (t: Thread) =>
      t.runner_id === this.runnerId &&
      !running.has(t.id) &&
      (t.waiting.length || t.limited || t.interrupted) &&
      (this.errored.get(t.id)?.after ?? 0) <= Date.now();
    ready.push(...work.filter(isReady));
    await this.claimUnowned(work, ready, running.size);
    ready.sort((a, b) => (a.waiting[0]?.id ?? "").localeCompare(b.waiting[0]?.id ?? ""));
    // A thread starts from its bot's newest prompt.
    for (const botId of new Set(ready.map((t) => t.bot_id))) {
      const bot = this.bots.find((b) => b.id === botId);
      if (bot) await this.refreshVersion(bot).catch(() => {});
    }

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
    const current = this.bots.find((b) => b.id === thread.bot_id)!;
    // A session can't move between harnesses: a thread this runner already ran keeps the one it started on.
    const pinned = thread.started ? this.sessions.get(id) : undefined;
    // The model goes with the harness it was picked for; on the same harness the bot's current model applies.
    const bot = pinned && pinned.harness !== current.harness ? { ...current, ...pinned } : current;
    this.sessions.set(id, { harness: bot.harness, model: bot.model });
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
        onPlanUsage: (outcome) => void this.ctx.metrics?.capture("plan_usage_reported", { outcome }),
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

  /** Makes the org's manager thread for a chat, owned by this runner. */
  createManagerThread(id: string): Promise<ManagerThread> {
    return this.client.createManagerThread(this.org, id, this.token());
  }

  /** Changes a manager thread this runner owns. */
  patchManagerThread(id: string, patch: ThreadPatch): Promise<ManagerThread> {
    return this.client.patchManagerThread(this.org, id, { ...patch, lease_token: this.token() });
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

/** When the runner lease a 409 `runner_leased` ran into expires, if the server said. */
function leasedUntil(err: ApiError): string | undefined {
  const details = err.details as { expires_at?: unknown } | undefined;
  return typeof details?.expires_at === "string" ? details.expires_at : undefined;
}

const RESUME_AFTER_INTERRUPT =
  "Your last run was cut off before it finished (the runner stopped, or the API failed). Carry on from wherever you got to, and check the thread's latest messages for anything you missed.";

const RESUME_AFTER_LIMIT =
  "Your last run stopped because the account hit its usage limit. The limit has reset: carry on with the messages you were given, from wherever you got to.";

function describeMessages(messages: ThreadMessage[]): string {
  const lines = messages.map(
    (m) => `- ${m.id}  ${m.type}  ${m.subject ?? ""}  (read: loopway messages get ${m.inbox_id} ${m.id} --data)`,
  );
  return `New messages for this thread:\n${lines.join("\n")}`;
}
