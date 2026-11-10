import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RateLimitError, type Poll, type Subject, type SubjectSource, type Update } from "./source.js";

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
    // Newest first, so stop paging once a page reaches back past `since`.
    const found: Subject[] = [];
    let path: string | undefined = `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=50`;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const result: { body: Issue[]; next?: string } = await this.page<Issue[]>(path);
      const { body, next } = result;
      for (const issue of body) {
        // Not <=: a subject made in the same second as the cursor comes back, and the poller drops the ones it knows.
        if (Date.parse(issue.created_at) < Date.parse(since)) return found;
        found.push({
          key: `${repo}#${issue.number}`,
          kind: issue.pull_request ? "pull_request" : "issue",
          title: issue.title,
          author: issue.user?.login ?? "ghost",
          createdAt: issue.created_at,
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

  async poll(subject: Subject, version?: string): Promise<Poll> {
    const result = await this.pollSubject(subject, version);
    // Only now is what the probe saw safe to call "seen": a failed poll above leaves it changed for next time.
    const signature = this.pending.get(subject.key);
    if (signature) this.signatures.set(subject.key, signature);
    return result;
  }

  private async pollSubject(subject: Subject, version?: string): Promise<Poll> {
    const [repo, number] = subject.key.split("#") as [string, string];
    const before = parseVersion(version);
    const issue = await this.get<Issue>(`/repos/${repo}/issues/${number}`);
    const isPr = Boolean(issue.pull_request);
    const pr = isPr ? await this.get<Pull>(`/repos/${repo}/pulls/${number}`) : undefined;
    const bodyHash = hash(`${issue.title}\n${issue.body ?? ""}`);
    const updates: Update[] = [];

    // Everything but CI bumps updated_at, so a subject that hasn't moved costs one request (a 304 or two).
    if (before.updatedAt !== issue.updated_at) {
      for (const e of await this.list<IssueEvent>(`/repos/${repo}/issues/${number}/events`)) {
        if (SKIPPED_EVENTS.has(e.event)) continue;
        updates.push({
          id: `event:${e.id}`,
          kind: e.event,
          detail: e.label?.name ?? e.assignee?.login ?? (e.rename ? `${e.rename.from} -> ${e.rename.to}` : undefined),
          actor: e.actor?.login ?? "ghost",
          at: e.created_at,
        });
      }
      for (const c of await this.list<Comment>(`/repos/${repo}/issues/${number}/comments`)) {
        const edited = c.updated_at !== c.created_at;
        updates.push({
          id: `comment:${c.id}:${c.updated_at}`,
          kind: edited ? "comment edited" : "comment",
          actor: c.user?.login ?? "ghost",
          at: c.updated_at,
        });
      }
      if (isPr) {
        for (const r of await this.list<Review>(`/repos/${repo}/pulls/${number}/reviews`)) {
          if (!r.submitted_at) continue; // a pending review is private to its author
          updates.push({
            id: `review:${r.id}`,
            kind: "review",
            detail: r.state.toLowerCase().replace("_", " "),
            actor: r.user?.login ?? "ghost",
            at: r.submitted_at,
          });
        }
        for (const c of await this.list<Comment>(`/repos/${repo}/pulls/${number}/comments`)) {
          const edited = c.updated_at !== c.created_at;
          updates.push({
            id: `review_comment:${c.id}:${c.updated_at}`,
            kind: edited ? "review comment edited" : "review comment",
            actor: c.user?.login ?? "ghost",
            at: c.updated_at,
          });
        }
      }
      // The first poll only learns what the body is; every later one reports a change to it.
      if (before.bodyHash && before.bodyHash !== bodyHash) {
        updates.push({
          id: `edit:${bodyHash}`,
          kind: "edited",
          actor: issue.user?.login ?? "ghost",
          at: issue.updated_at,
        });
      }
    }

    // CI belongs to the head commit and never touches the pull request's updated_at.
    if (pr && pr.state === "open") {
      const sha = pr.head.sha;
      const runs = await this.get<{ check_runs: CheckRun[] }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
      for (const run of runs.check_runs) {
        updates.push({
          id: `check_run:${run.id}:${run.status}:${run.conclusion ?? ""}`,
          kind: "check_run",
          detail: `${run.name} ${run.conclusion ?? run.status}`,
          actor: run.app?.slug ?? "github",
          at: run.completed_at ?? run.started_at ?? issue.updated_at,
        });
      }
      const combined = await this.get<{ statuses: CommitStatus[] }>(`/repos/${repo}/commits/${sha}/status`);
      for (const s of combined.statuses) {
        updates.push({
          id: `status:${s.id}:${s.state}`,
          kind: "status",
          detail: `${s.context} ${s.state}`,
          actor: s.creator?.login ?? "github",
          at: s.updated_at,
        });
      }
    }

    updates.sort((a, b) => a.at.localeCompare(b.at));
    return { updates, version: JSON.stringify({ updatedAt: issue.updated_at, bodyHash }) };
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
interface Issue {
  number: number;
  title: string;
  body: string | null;
  user: User | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}
interface Pull {
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
  user: User | null;
  created_at: string;
  updated_at: string;
}
interface Review {
  id: number;
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
