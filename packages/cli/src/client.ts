// Typed client for the loopway HTTP API (see docs/api.md for the contract).

import type { BotRule } from "@loopway/rules";
import { CLI_VERSION, VERSION_HEADER } from "./version.js";

export interface User {
  id: string;
  name: string;
  email: string | null;
  /** The slug of their personal org. Null until a new signup has picked one. */
  username: string | null;
  created_at: string;
}

export interface Source {
  type: string;
  label: string;
  description: string;
  /** Common event names, offered as choices. */
  events: string[];
  /** `loopway`: generated or entered at create time. `sender`: the sender makes it; set it afterwards. */
  secret: { from: "loopway"; min_length: number } | { from: "sender" } | { from: "none" };
  /** Where in the sender the webhook is added. */
  webhook_settings: string;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  personal: boolean;
}

export interface OrgMember {
  id: string;
  username: string | null;
  email: string | null;
}

export interface OrgMembers {
  members: OrgMember[];
  /** Emails added before they had an account; they join when they first log in. */
  pending: string[];
}

export interface Inbox {
  id: string;
  /** Who made it: `user:<uuid>`, `bot:<uuid>` or `runner:<id>`. Informational. */
  created_by: string;
  name: string;
  source_type: string;
  config: Record<string, unknown>;
  webhook_url: string;
  setup?: Record<string, unknown>;
  created_at: string;
  /** When a sender last reached the inbox, and how it went; null until one has. */
  last_delivery_at?: string | null;
  last_delivery_outcome?: string | null;
}

export interface InboxStats {
  messages: number;
}

export interface CloudEvent {
  specversion: string;
  id: string;
  source: string;
  type: string;
  subject?: string;
  time?: string;
  datacontenttype?: string;
  data?: unknown;
  [ext: string]: unknown;
}

export interface Message {
  id: string;
  inbox_id: string;
  /** Arrival order across all inboxes; bots read by it. */
  seq: number;
  received_at: string;
  event: CloudEvent;
}

/** One saved revision of a bot's prompt and assign rules. */
export interface BotVersion {
  version: number;
  prompt: string;
  /** Null for versions saved before bots had rules. */
  rules: BotRule[] | null;
  created_at: string;
}

export interface Bot {
  id: string;
  /** Who made it: `user:<uuid>`, `bot:<uuid>` or `runner:<id>`. Informational. */
  created_by: string;
  org_id: string;
  name: string;
  /** The model its sessions run on, as the bot's harness takes it. */
  model: string;
  /** The coding-agent CLI its sessions run in: `claude`, `cursor`, `codex`, `hermes` or `script`. */
  harness: string;
  inbox_ids: string[];
  /** The bot's newest prompt version; null if it has none yet. */
  prompt_version: BotVersion | null;
  /** The `seq` of the last message the bot has read past. */
  cursor: number;
  created_at: string;
}

/** A machine running loopway. */
export interface Runner {
  id: string;
  /** Who registered it: `user:<uuid>`, `bot:<uuid>` or `runner:<id>`. Informational. */
  created_by: string;
  /** The org it belongs to, for good. */
  org_id: string;
  /** The slug of that org. */
  org: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  /** Until when a process holds the runner's lease; null if none does. */
  leased_until: string | null;
  /** Bots whose live lease it holds. */
  bots: { id: string; name: string }[];
  /** Threads it owns. */
  threads: number;
}

/** Enough about an assigned message to deliver it without fetching it again. */
export interface ThreadMessage {
  id: string;
  inbox_id: string;
  type: string;
  subject: string | null;
}

export interface Thread {
  /** The agent session's id. */
  id: string;
  bot_id: string;
  /** The runner that assigned it for the bot (`runner:<id>`), or `bot:<uuid>` if the lease named no runner. Informational. */
  created_by: string;
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  /** The runner that owns the thread, whose machine has its session; null until a runner claims it. */
  runner_id: string | null;
  /** What the thread works on: for GitHub, its issues and PRs (`owner/repo#number`). */
  subjects: string[];
  /** From the newest message that carries one (an issue or PR title); null if none does. Older servers omit it. */
  title?: string | null;
  /** 2 if a person started it, 3 if a bot did and a person took part, 4 if no one did; null or omitted counts as 2. */
  automation_level?: 2 | 3 | 4 | null;
  /** What the thread's session recorded about itself with the `record` tool; older servers omit it. */
  metadata?: Record<string, unknown>;
  waiting: ThreadMessage[];
  inflight: ThreadMessage[];
  delivered: number;
  /** Only from getThread(). */
  delivered_ids?: string[];
  created_at: string;
  updated_at: string;
}

/** A chat with the org's manager: a thread of the org with no bot. */
export interface ManagerThread {
  /** The chat's session id. */
  id: string;
  bot_id: null;
  kind: "manager";
  /** `runner:<id>`, the runner that made it. */
  created_by: string;
  status: "active" | "ended";
  /** The runner that owns it, whose machine has the chat. */
  runner_id: string | null;
  /** What the runner and the manager recorded: `label` and `actions` (see `chatLabel`), and whatever else the manager did. */
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ThreadPatch {
  status?: "active" | "ended";
  started?: boolean;
  interrupted?: boolean;
  limited?: boolean;
  add_subjects?: string[];
  /** Keys to set, merged into the thread's metadata, and keys to remove. */
  metadata_set?: Record<string, unknown>;
  metadata_unset?: string[];
}

export interface Lease {
  token: string;
  expires_at: string;
}

export interface ListMessagesQuery {
  type?: string;
  limit?: number;
  order?: "asc" | "desc";
  cursor?: string;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class LoopwayClient {
  private baseUrl: string;
  private apiKey?: string;
  private fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetch = opts.fetch ?? fetch;
  }

  /** Emails a one-time code to the user with this address. Answers the same for unknown addresses. */
  async requestLoginCode(email: string) {
    await this.request("POST", "/auth/login", { email });
  }

  /**
   * Trades the emailed code for a session token. An email with no account needs a `username`: without one this is
   * 400 `username_required`, and a bad one is 400/409 `invalid_username`, `username_reserved`, `username_taken`.
   * The code stays valid after those, so the call can be repeated.
   */
  verifyLoginCode(email: string, code: string, username?: string) {
    return this.request<{ token: string; expires_at: string; user: User; created: boolean }>("POST", "/auth/verify", {
      email,
      code,
      ...(username && { username }),
    });
  }

  me() {
    return this.request<User>("GET", "/me");
  }

  /** Sets the username (the personal org's slug), or renames it. 400/409 `invalid_username`, `username_reserved`, `username_taken`. */
  setUsername(username: string) {
    return this.request<User>("PATCH", "/me/username", { username });
  }

  async listOrgs() {
    return (await this.request<{ data: Org[] }>("GET", "/orgs")).data;
  }

  /** Creates a shared org with you as its only member. 400/409 `invalid_username`, `username_reserved`, `username_taken`. */
  createOrg(slug: string, name?: string) {
    return this.request<Org>("POST", "/orgs", { slug, ...(name && { name }) });
  }

  /** Members and pending emails of an org you belong to (404 otherwise). */
  listOrgMembers(slug: string) {
    return this.request<OrgMembers>("GET", `/orgs/${enc(slug)}/members`);
  }

  /** Adds a member by email, or a pending membership if nobody has that email yet. Adding twice changes nothing. */
  addOrgMember(slug: string, email: string) {
    return this.request<OrgMembers>("POST", `/orgs/${enc(slug)}/members`, { email });
  }

  /** Removes a member, yourself included. 409 `last_member` for the only one left. */
  async removeOrgMember(slug: string, userId: string) {
    await this.request("DELETE", `/orgs/${enc(slug)}/members/${enc(userId)}`);
  }

  async removeOrgInvite(slug: string, email: string) {
    await this.request("DELETE", `/orgs/${enc(slug)}/members/pending?email=${enc(email)}`);
  }

  async sources() {
    return (await this.request<{ data: Source[] }>("GET", "/sources")).data;
  }

  // ---------- inboxes ----------

  /** The inboxes of one org (by slug). */
  async listInboxes(org: string) {
    return (await this.request<{ data: Inbox[] }>("GET", `/inboxes?org=${enc(org)}`)).data;
  }

  createInbox(input: { org: string; name: string; source_type: string; config?: unknown }) {
    return this.request<Inbox>("POST", "/inboxes", input);
  }

  getInbox(inboxId: string) {
    return this.request<Inbox & { stats: InboxStats }>("GET", `/inboxes/${enc(inboxId)}`);
  }

  updateInbox(inboxId: string, input: { name?: string; config?: unknown }) {
    return this.request<Inbox>("PATCH", `/inboxes/${enc(inboxId)}`, input);
  }

  /** Sends the inbox a sample message of its source, signed and stored like a real delivery. */
  testInbox(inboxId: string) {
    return this.request<{ message_id: string; seq: number }>("POST", `/inboxes/${enc(inboxId)}/test`, { from: "cli" });
  }

  // ---------- messages ----------

  listMessages(inboxId: string, q: ListMessagesQuery = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.size ? `?${qs}` : "";
    return this.request<{ data: Message[]; next_cursor: string | null }>("GET", `${messages(inboxId)}${suffix}`);
  }

  getMessage(inboxId: string, messageId: string) {
    return this.request<Message>("GET", `${messages(inboxId)}/${enc(messageId)}`);
  }

  // ---------- runners ----------

  /** Registers this machine's runner, or renames it and notes it was seen. Safe to repeat. */
  registerRunner(input: { org: string; id: string; name: string }) {
    return this.request<Runner>("POST", "/runners", input);
  }

  /**
   * Takes the runner's lease for this process, or renews it with the current token. 409 `runner_leased` if another
   * process holds it, with `details.expires_at`. Thread writes (patch, deliver, finish) take this lease's token.
   */
  leaseRunner(runnerId: string, opts: { ttl_seconds?: number; lease_token?: string } = {}) {
    return this.request<{ lease: Lease }>("POST", `/runners/${enc(runnerId)}/lease`, opts);
  }

  async releaseRunner(runnerId: string, leaseToken: string) {
    await this.request("POST", `/runners/${enc(runnerId)}/release`, { lease_token: leaseToken });
  }

  /** Drops the runner's lease whoever holds it: for a process that died without releasing. */
  async forceReleaseRunner(runnerId: string) {
    await this.request("POST", `/runners/${enc(runnerId)}/release`, { force: true });
  }

  /** The runners of one org (by slug). */
  async listRunners(org: string) {
    return (await this.request<{ data: Runner[] }>("GET", `/runners?org=${enc(org)}`)).data;
  }

  // ---------- bots ----------

  /** The bots of one org (by slug): a runner asks for only the bots it can run. */
  async listBots(org: string) {
    return (await this.request<{ data: Bot[] }>("GET", `/bots?org=${enc(org)}`)).data;
  }

  createBot(input: {
    org: string;
    name: string;
    model?: string;
    harness: string;
    inbox_ids: string[];
    prompt?: string;
    rules?: BotRule[];
  }) {
    return this.request<Bot>("POST", "/bots", input);
  }

  /** Every version of the bot, newest first. */
  async listBotVersions(botId: string) {
    return (await this.request<{ data: BotVersion[] }>("GET", `/bots/${enc(botId)}/versions`)).data;
  }

  /** Saves a new version for the bot; it becomes the bot's current one. Without `rules` it keeps the current ones. */
  addBotVersion(botId: string, prompt: string, rules?: BotRule[]) {
    return this.request<BotVersion>("POST", `/bots/${enc(botId)}/versions`, { prompt, rules });
  }

  getBot(botId: string) {
    return this.request<Bot>("GET", `/bots/${enc(botId)}`);
  }

  updateBot(botId: string, input: { name?: string; model?: string; harness?: string; inbox_ids?: string[] }) {
    return this.request<Bot>("PATCH", `/bots/${enc(botId)}`, input);
  }

  async deleteBot(botId: string) {
    await this.request("DELETE", `/bots/${enc(botId)}`);
  }

  /** Messages in the bot's inboxes after its cursor, oldest first. */
  async botMessages(botId: string, q: { limit?: number } = {}) {
    const suffix = q.limit ? `?limit=${q.limit}` : "";
    return (await this.request<{ data: Message[] }>("GET", `/bots/${enc(botId)}/messages${suffix}`)).data;
  }

  // ---------- threads ----------
  // Thread writes need the live lease token of the runner that owns the thread.

  /**
   * The bot's threads by `status`; `pending` is the active ones plus any ended one with a message still waiting
   * or in flight. `titles` (default true) asks the server to work out each thread's title.
   */
  async listThreads(botId: string, status: "active" | "ended" | "all" | "pending" = "active", titles = true) {
    return (
      await this.request<{ data: Thread[] }>("GET", `/bots/${enc(botId)}/threads?status=${status}&titles=${titles}`)
    ).data;
  }

  getThread(botId: string, threadId: string) {
    return this.request<Thread>("GET", `/bots/${enc(botId)}/threads/${enc(threadId)}`);
  }

  /**
   * Makes the runner holding the live lease `runnerLeaseToken` the thread's owner (fine if it already is). 409
   * `thread_owned` if another runner owns it, `runner_not_leased` if the token isn't a live runner lease.
   */
  claimThread(botId: string, threadId: string, runnerLeaseToken: string) {
    const path = `/bots/${enc(botId)}/threads/${enc(threadId)}/claim`;
    return this.request<Thread>("POST", path, { lease_token: runnerLeaseToken });
  }

  /** Gives the thread up so a runner can claim it: for when its runner is gone. Needs no lease. */
  releaseThread(botId: string, threadId: string) {
    return this.request<Thread>("POST", `/bots/${enc(botId)}/threads/${enc(threadId)}/release`, {});
  }

  /**
   * Ends the thread. Needs no lease; fine on an ended thread. Its waiting and inflight messages stay as they are, the
   * runner keeps its claim, and the next message for the thread resumes it.
   */
  endThread(botId: string, threadId: string) {
    return this.request<Thread>("POST", `/bots/${enc(botId)}/threads/${enc(threadId)}/end`, {});
  }

  /** The org's chats with the manager, oldest first. */
  async listManagerThreads(org: string) {
    return (await this.request<{ data: ManagerThread[] }>("GET", `/orgs/${enc(org)}/threads?kind=manager`)).data;
  }

  /**
   * Makes a manager thread with this id (the chat's session id), owned by the runner holding the live lease
   * `runnerLeaseToken`. 409 `thread_exists` if the id is taken, `runner_not_leased` if the token isn't a live lease.
   */
  createManagerThread(org: string, threadId: string, runnerLeaseToken: string) {
    return this.request<ManagerThread>("POST", `/orgs/${enc(org)}/threads`, {
      id: threadId,
      lease_token: runnerLeaseToken,
    });
  }

  /** Changes a manager thread's status or metadata; `lease_token` is the owning runner's live lease. */
  patchManagerThread(
    org: string,
    threadId: string,
    patch: Pick<ThreadPatch, "status" | "metadata_set" | "metadata_unset"> & { lease_token: string },
  ) {
    return this.request<ManagerThread>("PATCH", `/orgs/${enc(org)}/threads/${enc(threadId)}`, patch);
  }

  /**
   * Moves a subject from one thread of the bot to another, with its waiting messages, and
   * resumes the target if it ended. Needs no lease. 404 if the subject isn't on `fromThreadId` or a thread isn't the bot's.
   */
  moveSubject(botId: string, subject: string, fromThreadId: string, toThreadId: string) {
    const path = `/bots/${enc(botId)}/threads/${enc(fromThreadId)}/move-subject`;
    return this.request<Thread>("POST", path, { subject, to_thread_id: toThreadId });
  }

  /**
   * Sends a message to the thread through one of the bot's inboxes; the bot's runner hands it to the thread's
   * session. Needs no lease. 409 `no_inbox` if the bot has no inbox.
   */
  sendThreadMessage(botId: string, threadId: string, text: string) {
    const path = `/bots/${enc(botId)}/threads/${enc(threadId)}/messages`;
    return this.request<{ id: string; inbox_id: string }>("POST", path, { text });
  }

  patchThread(botId: string, threadId: string, input: ThreadPatch & { lease_token: string }) {
    return this.request<Thread>("PATCH", `/bots/${enc(botId)}/threads/${enc(threadId)}`, input);
  }

  /**
   * What this runner has to do for these bots, in one request: its own threads with waiting messages or a run to
   * resume, and the unowned threads with waiting messages, which it can claim. 404 from a server without it.
   */
  async runnerWork(runnerId: string, runnerLeaseToken: string, botIds: string[]) {
    const path = `/runners/${enc(runnerId)}/work?bots=${botIds.map(enc).join(",")}`;
    return (await this.request<{ data: Thread[] }>("GET", path, undefined, { "x-lease-token": runnerLeaseToken })).data;
  }

  /** Moves the thread's waiting messages to inflight, marks it active, and returns them. */
  async deliverThread(botId: string, threadId: string, leaseToken: string) {
    const path = `/bots/${enc(botId)}/threads/${enc(threadId)}/deliver`;
    return (await this.request<{ data: ThreadMessage[] }>("POST", path, { lease_token: leaseToken })).data;
  }

  /** Moves the thread's inflight messages to delivered, or back to waiting with `requeue`. */
  finishThread(botId: string, threadId: string, leaseToken: string, opts: { requeue?: boolean } = {}) {
    const path = `/bots/${enc(botId)}/threads/${enc(threadId)}/finish`;
    return this.request<{ moved: number }>("POST", path, { lease_token: leaseToken, ...opts });
  }

  // ---------- transport ----------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + "/api" + path, {
        method,
        headers: {
          accept: "application/json",
          [VERSION_HEADER]: CLI_VERSION,
          ...headers,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason =
        err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new ApiError(0, "network_error", `Could not reach ${this.baseUrl}: ${reason}`);
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(
          res.status,
          "bad_response",
          `Expected JSON from ${method} ${path}, got: ${text.slice(0, 200)}`,
        );
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`, e?.details);
    }
    return json as T;
  }
}

const enc = encodeURIComponent;
const messages = (inboxId: string) => `/inboxes/${enc(inboxId)}/messages`;
