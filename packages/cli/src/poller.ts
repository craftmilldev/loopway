import type { LoopwayEvent } from "./format.js";
import { RateLimitError, type SubjectSource } from "./source.js";
import type { State } from "./state.js";

export const DISCOVER_EVERY_MS = 2 * 60_000;
export const UPDATE_EVERY_MS = 30_000;

/** What the poller is up to, for a status line. */
export interface PollStatus {
  /** When the last poll finished (epoch ms), if one has. */
  lastCheckedAt: number | undefined;
  /** When the next poll is due (epoch ms). */
  nextAt: number;
  pausedUntil: number;
  /** A poll someone asked for is running. */
  refreshing: boolean;
}

export interface PollerOptions {
  source: SubjectSource;
  state: State;
  /** Called after every change to `state`. */
  save: (state: State) => Promise<void>;
  repos: string[];
  /** Logins whose issues and pull requests become subjects: you and the bot user. */
  authors: string[];
  /** Awaited before the poller saves its own state, so whatever acts on an event has recorded it first. */
  emit: (event: LoopwayEvent) => void | Promise<void>;
  /** Runs at the end of every pass over the known subjects: where answers to open asks are read. */
  answers?: () => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * Finds subjects and reports what happens to them. Discovery looks for new issues and pull requests by you or the bot;
 * `updates` looks at every known subject. Both only report what hasn't been reported, and both keep that in `state`.
 */
export class Poller {
  private readonly authors: Set<string>;
  private readonly now: () => number;
  /** No requests before this time (epoch ms): GitHub asked us to wait. */
  pausedUntil = 0;
  private nextDiscover = 0;
  private nextUpdate = 0;
  private inflight: Promise<void> | undefined;
  private forced = false;
  private lastCheckedAt: number | undefined;

  constructor(private readonly o: PollerOptions) {
    this.authors = new Set(o.authors.map((a) => a.toLowerCase()));
    this.now = o.now ?? Date.now;
  }

  async discover(): Promise<void> {
    const { source, state } = this.o;
    for (const repo of this.o.repos) {
      // A repo we've never seen starts now: no history is replayed.
      let since = state.repos[repo]?.since;
      if (!since) {
        since = new Date(this.now()).toISOString();
        state.repos[repo] = { since };
        await this.o.save(state);
      }
      const found = await source.discover(repo, since);
      let latest = since;
      for (const subject of found.reverse()) {
        if (Date.parse(subject.createdAt) > Date.parse(latest)) latest = subject.createdAt;
        if (state.subjects[subject.key] || !this.authors.has(subject.author.toLowerCase())) continue;
        state.subjects[subject.key] = { subject, seen: [] };
        await this.o.emit({ type: "new", subject });
        await this.o.save(state);
      }
      if (latest !== since) {
        state.repos[repo] = { since: latest };
        await this.o.save(state);
      }
    }
  }

  async updates(): Promise<void> {
    const { source, state } = this.o;
    // One batched question first, so quiet subjects cost nothing beyond it. If it fails for any reason but a rate
    // limit, ask about everything.
    let due: Set<string> | undefined;
    const subjects = Object.values(state.subjects).map((k) => k.subject);
    if (source.changed && subjects.length > 0) {
      try {
        due = await source.changed(subjects);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        this.o.log?.(`checking for changes: ${(err as Error).message}`);
      }
    }
    for (const [key, known] of Object.entries(state.subjects)) {
      if (due && !due.has(key)) continue;
      try {
        const got = await source.updates(known.subject, known.version);
        const seen = new Set(known.seen);
        for (const update of got.updates) {
          if (seen.has(update.id)) continue;
          seen.add(update.id);
          known.seen.push(update.id);
          await this.o.emit({ type: "update", subject: known.subject, update });
        }
        known.version = got.version;
        await this.o.save(state);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        this.o.log?.(`${key}: ${(err as Error).message}`);
      }
    }
    await this.o.answers?.();
  }

  /** Runs until `signal` aborts: discovery every 2 minutes, known subjects every 30 seconds, backing off on rate limits. */
  async run(signal: AbortSignal, sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep) {
    while (!signal.aborted) {
      await this.poll(false);
      const wake = Math.max(Math.min(this.nextDiscover, this.nextUpdate), this.pausedUntil);
      await sleep(Math.max(wake - this.now(), 0), signal);
    }
  }

  /**
   * Polls now, whatever the timers say, and restarts them from here. Does nothing while a poll is running, and says
   * so in the log instead of calling GitHub while it has asked us to wait.
   */
  async refresh(): Promise<void> {
    if (this.inflight) return;
    if (this.now() < this.pausedUntil) return this.o.log?.(this.waitingMessage());
    await this.poll(true);
  }

  status(): PollStatus {
    const nextAt = Math.max(Math.min(this.nextDiscover, this.nextUpdate), this.pausedUntil);
    return {
      lastCheckedAt: this.lastCheckedAt,
      nextAt,
      pausedUntil: this.pausedUntil,
      refreshing: !!this.inflight && this.forced,
    };
  }

  /** One poll, and the only one at a time: asking while one runs joins it. */
  private poll(force: boolean): Promise<void> {
    this.forced ||= force;
    return (this.inflight ??= this.pollOnce(force).finally(() => {
      this.inflight = undefined;
      this.forced = false;
    }));
  }

  /** Discovers and updates what is due (all of it if `force`), then sets the timers for next time. */
  private async pollOnce(force: boolean): Promise<void> {
    const t = this.now();
    if (t < this.pausedUntil) return;
    try {
      if (force || t >= this.nextDiscover) {
        await this.discover();
        this.nextDiscover = this.now() + DISCOVER_EVERY_MS;
      }
      if (force || t >= this.nextUpdate) {
        await this.updates();
        this.nextUpdate = this.now() + UPDATE_EVERY_MS;
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.pausedUntil = err.resumeAt;
        this.o.log?.(this.waitingMessage());
      } else {
        // Something broke that isn't ours to retry fast: say so and try again at the normal pace.
        this.o.log?.((err as Error).message);
        this.nextDiscover = Math.max(this.nextDiscover, this.now() + DISCOVER_EVERY_MS);
        this.nextUpdate = Math.max(this.nextUpdate, this.now() + UPDATE_EVERY_MS);
      }
    }
    this.lastCheckedAt = this.now();
  }

  private waitingMessage = () => `rate limited: waiting ${Math.ceil((this.pausedUntil - this.now()) / 1000)}s`;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
