import type { LoopwayEvent } from "./format.js";
import { RateLimitError, type SubjectSource } from "./source.js";
import type { State } from "./state.js";

export const DISCOVER_EVERY_MS = 2 * 60_000;
export const UPDATE_EVERY_MS = 30_000;

export interface PollerOptions {
  source: SubjectSource;
  state: State;
  /** Called after every change to `state`. */
  save: (state: State) => Promise<void>;
  repos: string[];
  /** Logins whose issues and pull requests become subjects: you and the bot user. */
  authors: string[];
  emit: (event: LoopwayEvent) => void;
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
        await this.o.save(state);
        this.o.emit({ type: "new", subject });
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
          this.o.emit({ type: "update", subject: key, update });
        }
        known.version = got.version;
        await this.o.save(state);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        this.o.log?.(`${key}: ${(err as Error).message}`);
      }
    }
  }

  /** Runs until `signal` aborts: discovery every 2 minutes, known subjects every 30 seconds, backing off on rate limits. */
  async run(signal: AbortSignal, sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep) {
    let nextDiscover = 0;
    let nextUpdate = 0;
    while (!signal.aborted) {
      const t = this.now();
      if (t >= this.pausedUntil) {
        try {
          if (t >= nextDiscover) {
            await this.discover();
            nextDiscover = this.now() + DISCOVER_EVERY_MS;
          }
          if (t >= nextUpdate) {
            await this.updates();
            nextUpdate = this.now() + UPDATE_EVERY_MS;
          }
        } catch (err) {
          if (!(err instanceof RateLimitError)) {
            // Something broke that isn't ours to retry fast: say so and try again at the normal pace.
            this.o.log?.((err as Error).message);
            nextDiscover = Math.max(nextDiscover, this.now() + DISCOVER_EVERY_MS);
            nextUpdate = Math.max(nextUpdate, this.now() + UPDATE_EVERY_MS);
          } else {
            this.pausedUntil = err.resumeAt;
            this.o.log?.(`rate limited: waiting ${Math.ceil((err.resumeAt - this.now()) / 1000)}s`);
          }
        }
      }
      const wake = Math.max(Math.min(nextDiscover, nextUpdate), this.pausedUntil);
      await sleep(Math.max(wake - this.now(), 0), signal);
    }
  }
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
