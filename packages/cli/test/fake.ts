import type { LoopwayEvent } from "../src/format.js";
import { Poller } from "../src/poller.js";
import {
  RateLimitError,
  type Made,
  type Reaction,
  type Updates,
  type Subject,
  type SubjectSource,
  type Update,
} from "../src/source.js";
import { emptyState, type State } from "../src/state.js";

/** GitHub, in memory. Tests add subjects and updates, and can make the next calls fail. */
export class FakeSource implements SubjectSource {
  subjects: Subject[] = [];
  /** Set to give the poller a batched probe. */
  changed?: (subjects: Subject[]) => Promise<Set<string>>;
  said = new Map<string, Update[]>();
  /** Reactions by comment URL. */
  reacted = new Map<string, Reaction[]>();
  failWith: Error | undefined;
  calls: string[] = [];

  async whoami() {
    return "me";
  }

  async discover(repo: string, since: string) {
    this.calls.push(`discover ${repo}`);
    this.maybeFail();
    return this.subjects
      .filter((s) => s.key.startsWith(repo + "#") && Date.parse(s.updatedAt ?? s.createdAt) >= Date.parse(since))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updates(subject: Subject): Promise<Updates> {
    this.calls.push(`updates ${subject.key}`);
    this.maybeFail();
    return { updates: this.said.get(subject.key) ?? [] };
  }

  async reactions(commentUrl: string) {
    this.calls.push(`reactions ${commentUrl}`);
    this.maybeFail();
    return this.reacted.get(commentUrl) ?? [];
  }

  react(commentUrl: string, user: string, content: string) {
    this.reacted.set(commentUrl, [...(this.reacted.get(commentUrl) ?? []), { user, content }]);
  }

  add(key: string, author: string, createdAt: string, kind: Subject["kind"] = "issue", body?: string) {
    this.subjects.push({ key, kind, title: `title of ${key}`, author, createdAt, ...(body ? { body } : {}) });
  }

  /** Something happened to a subject at `at`: its last activity moves. */
  touch(key: string, at: string) {
    const s = this.subjects.find((x) => x.key === key);
    if (s) s.updatedAt = at;
  }

  /** Closes a subject, or reopens it. */
  setOpen(key: string, open: boolean) {
    const s = this.subjects.find((x) => x.key === key);
    if (s) s.open = open;
  }

  say(key: string, update: Partial<Update> & { id: string }) {
    const full: Update = { kind: "comment", actor: "me", at: "2026-11-10T14:00:00Z", ...update };
    this.said.set(key, [...(this.said.get(key) ?? []), full]);
  }

  private maybeFail() {
    if (this.failWith) throw this.failWith;
  }
}

/**
 * Opening issues and pull requests as loopway-bot, in memory: numbered from 101, each one noted in `opened`. Set
 * `refuses` to make GitHub turn them down with that message.
 */
export function fakeOpening() {
  let number = 100;
  const opened: string[] = [];
  const open = (kind: Subject["kind"], repo: string, title: string, body: string, note: string): Made => {
    if (opening.refuses) throw new Error(opening.refuses);
    number++;
    opened.push(`${note}: ${body}`);
    const path = kind === "issue" ? "issues" : "pull";
    const subject = {
      key: `${repo}#${number}`,
      kind,
      title,
      author: "loopway-bot",
      createdAt: "2026-11-10T15:00:00Z",
      body,
    };
    return { subject, url: `https://github.com/${repo}/${path}/${number}` };
  };
  const opening = {
    refuses: "",
    opened,
    createIssue: async (repo: string, title: string, body: string) =>
      open("issue", repo, title, body, `issue ${repo} ${title}`),
    createPr: async (repo: string, head: string, base: string, title: string, body: string) =>
      open("pull_request", repo, title, body, `pr ${repo} ${head}->${base} ${title}`),
  };
  return opening;
}

export const rateLimited = (resumeAt: number) => new RateLimitError(resumeAt);

/** A poller over a fake source whose clock the test moves, and the events it printed. */
export function harness(
  opts: {
    state?: State;
    authors?: string[];
    repos?: string[];
    start?: string;
    /** Runs at the end of each pass over the known subjects. */
    answers?: () => Promise<void>;
    /** Runs after each event is recorded, like the threads do in the real command. */
    react?: (event: LoopwayEvent, push: (e: LoopwayEvent) => void) => Promise<void>;
  } = {},
) {
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
    emit: async (e) => {
      events.push(e);
      await opts.react?.(e, (x) => events.push(x));
    },
    answers: opts.answers,
    log: (m) => logs.push(m),
    now: () => clock.t,
  });
  return { source, state, events, logs, saved, clock, poller };
}
