// Typed client for the loopway HTTP API (see docs/api.md for the contract).

export interface User {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
}

export interface Source {
  type: string;
  label: string;
  description: string;
  /** Common event names, offered as choices. */
  events: string[];
  /** `loopway`: generated or entered at create time. `sender`: the sender makes it; set it afterwards. */
  secret: { from: "loopway"; min_length: number } | { from: "sender" };
  /** Where in the sender the webhook is added. */
  webhook_settings: string;
}

export interface Inbox {
  id: string;
  name: string;
  source_type: string;
  config: Record<string, unknown>;
  webhook_url: string;
  setup?: Record<string, unknown>;
  created_at: string;
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

export interface Bot {
  id: string;
  name: string;
  kind: string;
  inbox_ids: string[];
  /** The `seq` of the last message the bot has read past. */
  cursor: number;
  created_at: string;
}

/** A machine running loopway. */
export interface Runner {
  id: string;
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
  /** The Claude session id. */
  id: string;
  bot_id: string;
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  /** The runner that owns the thread, whose machine has its session; null until a runner claims it. */
  runner_id: string | null;
  /** What the thread works on: for GitHub, its issues and PRs (`owner/repo#number`). */
  subjects: string[];
  waiting: ThreadMessage[];
  inflight: ThreadMessage[];
  delivered: number;
  /** Only from getThread(). */
  delivered_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface Assignment {
  message_id: string;
  thread_id: string;
  add_subjects?: string[];
  subject?: string;
}

export interface ThreadPatch {
  status?: "active" | "ended";
  started?: boolean;
  interrupted?: boolean;
  limited?: boolean;
  add_subjects?: string[];
}

export interface ImportThread {
  id: string;
  subjects: string[];
  status: "active" | "ended";
  started: boolean;
  interrupted?: boolean;
  limited?: boolean;
  /** The runner that owns the thread: the one whose machine has the session. */
  runner_id?: string;
  /** Bring a thread that exists, owned by `runner_id`, up to date from this instead of failing with `thread_exists`. */
  refresh?: boolean;
  messages: { id: string; state: "waiting" | "inflight" | "delivered"; subject?: string }[];
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

  /** Trades the emailed code for a session token. */
  verifyLoginCode(email: string, code: string) {
    return this.request<{ token: string; expires_at: string; user: User; created: boolean }>("POST", "/auth/verify", {
      email,
      code,
    });
  }

  me() {
    return this.request<User>("GET", "/me");
  }

  async sources() {
    return (await this.request<{ data: Source[] }>("GET", "/sources")).data;
  }

  // ---------- inboxes ----------

  async listInboxes() {
    return (await this.request<{ data: Inbox[] }>("GET", "/inboxes")).data;
  }

  createInbox(input: { name: string; source_type: string; config?: unknown }) {
    return this.request<Inbox>("POST", "/inboxes", input);
  }

  getInbox(inboxId: string) {
    return this.request<Inbox & { stats: InboxStats }>("GET", `/inboxes/${enc(inboxId)}`);
  }

  updateInbox(inboxId: string, input: { name?: string; config?: unknown }) {
    return this.request<Inbox>("PATCH", `/inboxes/${enc(inboxId)}`, input);
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
  registerRunner(input: { id: string; name: string }) {
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

  async listRunners() {
    return (await this.request<{ data: Runner[] }>("GET", "/runners")).data;
  }

  // ---------- bots ----------

  async listBots() {
    return (await this.request<{ data: Bot[] }>("GET", "/bots")).data;
  }

  createBot(input: { name: string; kind: string; inbox_ids: string[] }) {
    return this.request<Bot>("POST", "/bots", input);
  }

  getBot(botId: string) {
    return this.request<Bot>("GET", `/bots/${enc(botId)}`);
  }

  updateBot(botId: string, input: { name?: string; inbox_ids?: string[] }) {
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

  /**
   * Takes the bot's lease, or renews it with the current token. 409 `leased` if another runner holds it,
   * with `details.expires_at` saying until when.
   */
  leaseBot(botId: string, opts: { ttl_seconds?: number; lease_token?: string; runner_id?: string } = {}) {
    return this.request<{ lease: Lease }>("POST", `/bots/${enc(botId)}/lease`, opts);
  }

  async releaseBot(botId: string, leaseToken: string) {
    await this.request("POST", `/bots/${enc(botId)}/release`, { lease_token: leaseToken });
  }

  /** Drops the bot's lease whoever holds it: for a runner that died without releasing. */
  async forceReleaseBot(botId: string) {
    await this.request("POST", `/bots/${enc(botId)}/release`, { force: true });
  }

  /** Moves the cursor forward to `seq`; it never goes backwards. 409 if the token isn't the live lease. */
  advanceCursor(botId: string, seq: number, leaseToken: string) {
    return this.request<Bot>("POST", `/bots/${enc(botId)}/cursor`, { seq, lease_token: leaseToken });
  }

  // ---------- threads ----------

  /** `assign` needs the bot's live lease token; thread writes need the live lease token of the runner that owns the thread. */
  async listThreads(botId: string, status: "active" | "ended" | "all" = "active") {
    return (await this.request<{ data: Thread[] }>("GET", `/bots/${enc(botId)}/threads?status=${status}`)).data;
  }

  getThread(botId: string, threadId: string) {
    return this.request<Thread>("GET", `/bots/${enc(botId)}/threads/${enc(threadId)}`);
  }

  /**
   * Hands messages to threads (creating the ones the bot doesn't have) as waiting, and moves the cursor to `cursor`,
   * all or nothing. A message that's already assigned is skipped. 409 `subject_taken` if a subject is on another thread.
   */
  assign(botId: string, input: { lease_token: string; cursor: number; assignments: Assignment[] }) {
    return this.request<{ assigned: number }>("POST", `/bots/${enc(botId)}/assign`, input);
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

  patchThread(botId: string, threadId: string, input: ThreadPatch & { lease_token: string }) {
    return this.request<Thread>("PATCH", `/bots/${enc(botId)}/threads/${enc(threadId)}`, input);
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

  /**
   * Creates a thread with this id; 409 `thread_exists` if there is one (unless `refresh` and `runner_id` owns it),
   * `subject_taken` if another thread has a subject.
   */
  importThread(botId: string, input: ImportThread) {
    return this.request<{ thread: Thread; skipped: number }>("POST", `/bots/${enc(botId)}/threads`, input);
  }

  // ---------- transport ----------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers: {
          accept: "application/json",
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
