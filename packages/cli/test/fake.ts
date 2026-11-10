import type { LoopwayEvent } from "../src/format.js";
import { Poller } from "../src/poller.js";
import { RateLimitError, type Updates, type Subject, type SubjectSource, type Update } from "../src/source.js";
import { emptyState, type State } from "../src/state.js";

/** GitHub, in memory. Tests add subjects and updates, and can make the next calls fail. */
export class FakeSource implements SubjectSource {
  subjects: Subject[] = [];
  /** Set to give the poller a batched probe. */
  changed?: (subjects: Subject[]) => Promise<Set<string>>;
  said = new Map<string, Update[]>();
  failWith: Error | undefined;
  calls: string[] = [];

  async whoami() {
    return "me";
  }

  async discover(repo: string, since: string) {
    this.calls.push(`discover ${repo}`);
    this.maybeFail();
    return this.subjects
      .filter((s) => s.key.startsWith(repo + "#") && Date.parse(s.createdAt) >= Date.parse(since))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updates(subject: Subject): Promise<Updates> {
    this.calls.push(`updates ${subject.key}`);
    this.maybeFail();
    return { updates: this.said.get(subject.key) ?? [] };
  }

  add(key: string, author: string, createdAt: string, kind: Subject["kind"] = "issue") {
    this.subjects.push({ key, kind, title: `title of ${key}`, author, createdAt });
  }

  say(key: string, update: Partial<Update> & { id: string }) {
    const full: Update = { kind: "comment", actor: "me", at: "2026-11-10T14:00:00Z", ...update };
    this.said.set(key, [...(this.said.get(key) ?? []), full]);
  }

  private maybeFail() {
    if (this.failWith) throw this.failWith;
  }
}

export const rateLimited = (resumeAt: number) => new RateLimitError(resumeAt);

/** A poller over a fake source whose clock the test moves, and the events it printed. */
export function harness(opts: { state?: State; authors?: string[]; repos?: string[]; start?: string } = {}) {
  const source = new FakeSource();
  const state = opts.state ?? emptyState();
  const events: LoopwayEvent[] = [];
  const logs: string[] = [];
  const saved: string[] = [];
  const clock = { t: Date.parse(opts.start ?? "2026-11-10T12:00:00Z") };
  const poller = new Poller({
    source,
    state,
    save: async (s) => void saved.push(JSON.stringify(s)),
    repos: opts.repos ?? ["o/r"],
    authors: opts.authors ?? ["me", "loopway-bot"],
    emit: (e) => events.push(e),
    log: (m) => logs.push(m),
    now: () => clock.t,
  });
  return { source, state, events, logs, saved, clock, poller };
}
