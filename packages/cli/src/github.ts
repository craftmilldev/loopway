import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  RateLimitError,
  type Made,
  type Reaction,
  type Updates,
  type Subject,
  type SubjectSource,
  type Update,
} from "./source.js";

const API = "https://api.github.com";
const MAX_PAGES = 10;
const PROBE_BATCH = 50;
// Enough to tell whether a subject, or the CI on its head commit, has moved.
const PROBE = `... on Issue { updatedAt state }
  ... on PullRequest { updatedAt state commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } }`;

/** Your `gh` login: GH_TOKEN or GITHUB_TOKEN if set, else `gh auth token`. */
export function ghToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (token) return token;
  } catch {
    // fall through to the message below
  }
  throw new Error("No GitHub login found. Run `gh auth login` (or set GH_TOKEN).");
}

interface Options {
  token: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface Cached {
  etag: string;
  body: unknown;
  next?: string;
}

/**
 * GitHub over its REST API. Requests are conditional (ETag), and a 304 doesn't count against the rate limit, so asking
 * about a quiet subject every 30 seconds is nearly free.
 */
export class GitHubSource implements SubjectSource {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly token: string;
  private readonly cache = new Map<string, Cached>();
  /** What `changed` last saw per subject, and what `poll` has since taken in. Only in memory: a restart polls all. */
  private readonly pending = new Map<string, string>();
  private readonly signatures = new Map<string, string>();

  constructor(options: Options) {
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async whoami(): Promise<string> {
    const user = await this.get<{ login: string }>("/user");
    return user.login;
  }

  async discover(repo: string, since: string): Promise<Subject[]> {
    // Most recently active first, so stop paging once a page reaches back past `since`. The `since` parameter
    // already drops what was not touched after it.
    const found: Subject[] = [];
    let path: string | undefined =
      `/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50&since=${encodeURIComponent(since)}`;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const result: { body: Issue[]; next?: string } = await this.page<Issue[]>(path);
      const { body, next } = result;
      for (const issue of body) {
        // Not <=: a subject made in the same second as the cursor comes back, and the poller drops the ones it knows.
        if (Date.parse(issue.updated_at) < Date.parse(since)) return found;
        found.push({
          key: `${repo}#${issue.number}`,
          kind: issue.pull_request ? "pull_request" : "issue",
          title: issue.title,
          author: issue.user?.login ?? "ghost",
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          open: issue.state === "open",
          assignees: (issue.assignees ?? []).map((a) => a.login),
          ...(issue.body ? { body: issue.body } : {}),
        });
      }
      path = next;
    }
    return found;
  }

  /**
   * One GraphQL call per 50 subjects: each one's updatedAt, state and CI results. Anything that differs from what the
   * last successful `poll` of it saw is reported as changed. The first look at a subject always is, so a start-up polls
   * everything once.
   */
  async changed(subjects: Subject[]): Promise<Set<string>> {
    const changed = new Set<string>();
    for (let i = 0; i < subjects.length; i += PROBE_BATCH) {
      const batch = subjects.slice(i, i + PROBE_BATCH);
      const fields = batch.map((s, j) => {
        const [repo, number] = s.key.split("#") as [string, string];
        const [owner, name] = repo.split("/") as [string, string];
        return `s${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issueOrPullRequest(number: ${Number(number)}) { ${PROBE} } }`;
      });
      const data = await this.graphql(`query { ${fields.join("\n")} }`);
      batch.forEach((s, j) => {
        const node = data[`s${j}`]?.issueOrPullRequest;
        const signature = node ? JSON.stringify(node) : undefined;
        if (!signature)
          changed.add(s.key); // gone or unreadable: let the REST poll say why
        else {
          if (this.signatures.get(s.key) !== signature) changed.add(s.key);
          this.pending.set(s.key, signature);
        }
      });
    }
    return changed;
  }

  async teamMembers(team: string): Promise<string[]> {
    const [org, slug] = team.split("/") as [string, string];
    const members = await this.list<User>(`/orgs/${org}/teams/${slug}/members`);
    return members.map((m) => m.login);
  }

  /** Posts a comment on an issue or pull request (`owner/repo#N`) as whoever the token belongs to. Returns its URL. */
  async comment(subject: string, body: string): Promise<string> {
    const [repo, number] = subject.split("#") as [string, string];
    const created = await this.post<{ html_url: string }>(`/repos/${repo}/issues/${Number(number)}/comments`, { body });
    return created.html_url;
  }

  /** Opens an issue as whoever the token belongs to. */
  async createIssue(repo: string, title: string, body: string, assignees: string[] = []): Promise<Made> {
    const payload = { title, body, ...(assignees.length ? { assignees } : {}) };
    return madeOf(repo, "issue", await this.post<Created>(`/repos/${repo}/issues`, payload));
  }

  /** Opens a pull request from the branch `head` into `base`, as whoever the token belongs to. */
  async createPr(repo: string, head: string, base: string, title: string, body: string): Promise<Made> {
    return madeOf(repo, "pull_request", await this.post<Created>(`/repos/${repo}/pulls`, { head, base, title, body }));
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const res = await this.fetch(API + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "loopway",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await this.failure(res, path);
    return (await res.json()) as T;
  }

  /** The reactions on a comment, from the URL it was posted at (`.../issues/N#issuecomment-ID`). */
  async reactions(commentUrl: string): Promise<Reaction[]> {
    const found = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/.exec(commentUrl);
    if (!found) throw new Error(`"${commentUrl}" is not a comment URL`);
    const reactions = await this.list<{ content: string; user?: { login: string } }>(
      `/repos/${found[1]}/issues/comments/${found[2]}/reactions`,
    );
    return reactions.map((r) => ({ content: r.content, user: r.user?.login ?? "ghost" }));
  }

  /** Everything visible about a subject, as a series of steps. Each step looks at one kind of thing and knows when to skip. */
  async updates(subject: Subject, version?: string): Promise<Updates> {
    const look = await this.look(subject, version);
    const updates = [
      ...(await this.events(look)),
      ...(await this.comments(look)),
      ...(await this.reviews(look)),
      ...(await this.reviewComments(look)),
      ...this.edits(look),
      ...(await this.checkRuns(look)),
      ...(await this.statuses(look)),
    ].sort((a, b) => a.at.localeCompare(b.at));
    // Only now is what the probe saw safe to call "seen": a failure above leaves the subject changed for next time.
    const signature = this.pending.get(subject.key);
    if (signature) this.signatures.set(subject.key, signature);
    return { updates, version: JSON.stringify({ updatedAt: look.item.updated_at, bodyHash: look.bodyHash }) };
  }

  /** The subject as it is now, and what the last poll knew of it. */
  private async look(subject: Subject, version?: string): Promise<Look> {
    const [repo, number] = subject.key.split("#") as [string, string];
    const before = parseVersion(version);
    // A pull request is read from its own endpoint, which has everything the issue one does plus its head commit.
    const pr = subject.kind === "pull_request" ? await this.get<Pull>(`/repos/${repo}/pulls/${number}`) : undefined;
    const item = pr ?? (await this.get<Issue>(`/repos/${repo}/issues/${number}`));
    const bodyHash = hash(`${item.title}\n${item.body ?? ""}`);
    // Everything but CI bumps updated_at, so a subject that has not moved costs a request or two.
    return { repo, number, item, pr, bodyHash, before, moved: before.updatedAt !== item.updated_at };
  }

  private async events(l: Look): Promise<Update[]> {
    if (!l.moved) return [];
    const events = await this.list<IssueEvent>(`/repos/${l.repo}/issues/${l.number}/events`);
    return events
      .filter((e) => !SKIPPED_EVENTS.has(e.event))
      .map((e) => ({
        id: `event:${e.id}`,
        kind: e.event,
        detail: e.label?.name ?? e.assignee?.login ?? (e.rename ? `${e.rename.from} -> ${e.rename.to}` : undefined),
        actor: e.actor?.login ?? "ghost",
        at: e.created_at,
      }));
  }

  private async comments(l: Look): Promise<Update[]> {
    if (!l.moved) return [];
    const comments = await this.list<Comment>(`/repos/${l.repo}/issues/${l.number}/comments`);
    return comments.map((c) => commentUpdate("comment", c));
  }

  private async reviews(l: Look): Promise<Update[]> {
    if (!l.moved || !l.pr) return [];
    const reviews = await this.list<Review>(`/repos/${l.repo}/pulls/${l.number}/reviews`);
    return reviews
      .filter((r) => r.submitted_at) // a pending review is private to its author
      .map((r) => ({
        id: `review:${r.id}`,
        kind: "review",
        detail: r.state.toLowerCase().replace("_", " "),
        ...(r.body ? { body: r.body } : {}),
        actor: r.user?.login ?? "ghost",
        at: r.submitted_at ?? l.item.updated_at,
      }));
  }

  private async reviewComments(l: Look): Promise<Update[]> {
    if (!l.moved || !l.pr) return [];
    const comments = await this.list<Comment>(`/repos/${l.repo}/pulls/${l.number}/comments`);
    return comments.map((c) => commentUpdate("review comment", c));
  }

  /** A changed title or body. The first look only learns what it is; every later one reports a change. */
  private edits(l: Look): Update[] {
    if (!l.moved || !l.before.bodyHash || l.before.bodyHash === l.bodyHash) return [];
    return [{ id: `edit:${l.bodyHash}`, kind: "edited", actor: l.item.user?.login ?? "ghost", at: l.item.updated_at }];
  }

  /** CI belongs to the head commit and never touches the pull request's updated_at, so it is asked every time. */
  private async checkRuns(l: Look): Promise<Update[]> {
    if (l.pr?.state !== "open") return [];
    const { check_runs } = await this.get<{ check_runs: CheckRun[] }>(
      `/repos/${l.repo}/commits/${l.pr.head.sha}/check-runs?per_page=100`,
    );
    return check_runs.map((run) => ({
      id: `check_run:${run.id}:${run.status}:${run.conclusion ?? ""}`,
      kind: "check_run",
      detail: `${run.name} ${run.conclusion ?? run.status}`,
      actor: run.app?.slug ?? "github",
      at: run.completed_at ?? run.started_at ?? l.item.updated_at,
    }));
  }

  private async statuses(l: Look): Promise<Update[]> {
    if (l.pr?.state !== "open") return [];
    const { statuses } = await this.get<{ statuses: CommitStatus[] }>(
      `/repos/${l.repo}/commits/${l.pr.head.sha}/status`,
    );
    return statuses.map((s) => ({
      id: `status:${s.id}:${s.state}`,
      kind: "status",
      detail: `${s.context} ${s.state}`,
      actor: s.creator?.login ?? "github",
      at: s.updated_at,
    }));
  }

  private async graphql(query: string): Promise<Record<string, { issueOrPullRequest?: unknown } | null | undefined>> {
    const res = await this.fetch(API + "/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "loopway",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw await this.failure(res, "/graphql");
    // Partial data with errors (a deleted issue, say) is fine: the subjects missing from it count as changed.
    const body = (await res.json()) as { data?: Record<string, { issueOrPullRequest?: unknown } | null> };
    return body.data ?? {};
  }

  private get<T>(path: string): Promise<T> {
    return this.page<T>(path).then((r) => r.body);
  }

  /** Every item of a paginated list. */
  private async list<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const r: { body: T[]; next?: string } = await this.page<T[]>(next);
      all.push(...r.body);
      next = r.next;
    }
    return all;
  }

  private async page<T>(path: string): Promise<{ body: T; next?: string }> {
    const url = path.startsWith("http") ? path : API + path;
    const cached = this.cache.get(url);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "loopway",
    };
    if (cached) headers["if-none-match"] = cached.etag;
    const res = await this.fetch(url, { headers });
    if (res.status === 304 && cached) return { body: cached.body as T, next: cached.next };
    if (!res.ok) throw await this.failure(res, url);
    const body = (await res.json()) as T;
    const next = nextLink(res.headers.get("link"));
    const etag = res.headers.get("etag");
    if (etag) this.cache.set(url, { etag, body, next });
    return { body, next };
  }

  private async failure(res: Response, url: string): Promise<Error> {
    const text = await res.text().catch(() => "");
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
    if (res.status === 429 || (res.status === 403 && (retryAfter || exhausted || /rate limit/i.test(text)))) {
      let resumeAt = this.now() + 60_000;
      if (retryAfter) resumeAt = this.now() + Number(retryAfter) * 1000;
      else if (exhausted && reset) resumeAt = Number(reset) * 1000;
      return new RateLimitError(resumeAt, `GitHub rate limit hit on ${url}`);
    }
    return new Error(`GitHub ${res.status} on ${url}: ${text.slice(0, 200)}`);
  }
}

/** What one look at a subject learned, handed to each step of `updates`. */
interface Look {
  repo: string;
  number: string;
  item: Item;
  /** Set for a pull request. */
  pr?: Pull;
  bodyHash: string;
  before: { updatedAt?: string; bodyHash?: string };
  /** Whether it has changed since the last poll (CI aside). */
  moved: boolean;
}

/** What GitHub answers to opening an issue or a pull request. */
interface Created extends Item {
  number: number;
  assignees?: User[];
  created_at: string;
  html_url: string;
}

function madeOf(repo: string, kind: Subject["kind"], c: Created): Made {
  const subject: Subject = {
    key: `${repo}#${c.number}`,
    kind,
    title: c.title,
    author: c.user?.login ?? "ghost",
    createdAt: c.created_at,
    assignees: (c.assignees ?? []).map((a) => a.login),
    ...(c.body ? { body: c.body } : {}),
  };
  return { subject, url: c.html_url };
}

function commentUpdate(what: "comment" | "review comment", c: Comment): Update {
  return {
    id: `${what.replace(" ", "_")}:${c.id}:${c.updated_at}`,
    kind: c.updated_at !== c.created_at ? `${what} edited` : what,
    ...(c.body ? { body: c.body } : {}),
    actor: c.user?.login ?? "ghost",
    at: c.updated_at,
  };
}

// Noise that says nothing happened to the work itself.
const SKIPPED_EVENTS = new Set(["subscribed", "unsubscribed", "mentioned"]);

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

function parseVersion(version?: string): { updatedAt?: string; bodyHash?: string } {
  if (!version) return {};
  try {
    return JSON.parse(version) as { updatedAt?: string; bodyHash?: string };
  } catch {
    return {};
  }
}

function nextLink(link: string | null): string | undefined {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

interface User {
  login: string;
}
interface Item {
  title: string;
  body: string | null;
  user: User | null;
  updated_at: string;
}
interface Issue extends Item {
  number: number;
  state: string;
  assignees?: User[];
  created_at: string;
  pull_request?: unknown;
}
interface Pull extends Item {
  state: string;
  head: { sha: string };
}
interface IssueEvent {
  id: number;
  event: string;
  actor: User | null;
  created_at: string;
  label?: { name: string };
  assignee?: User;
  rename?: { from: string; to: string };
}
interface Comment {
  id: number;
  body?: string;
  user: User | null;
  created_at: string;
  updated_at: string;
}
interface Review {
  id: number;
  body?: string | null;
  user: User | null;
  state: string;
  submitted_at?: string;
}
interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  completed_at?: string;
  app?: { slug: string };
}
interface CommitStatus {
  id: number;
  context: string;
  state: string;
  updated_at: string;
  creator?: User;
}
