// Typed client for the loopway HTTP API (see the API section of the README for the contract).

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
  pending: number;
  locked: number;
  processed: number;
}

export type EventStatus = "pending" | "locked" | "processed";
export const LIST_STATUSES = ["all", "pending", "locked", "processed", "unprocessed"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

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

export interface Event {
  id: string;
  inbox_id: string;
  status: EventStatus;
  received_at: string;
  locked_until: string | null;
  processed_at: string | null;
  lock_count: number;
  event: CloudEvent;
}

export interface LockedEvent extends Event {
  lock: { token: string; expires_at: string };
}

export interface ListEventsQuery {
  status?: ListStatus;
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
    return this.request<{ token: string; expires_at: string; user: User; created: boolean }>("POST", "/auth/verify", { email, code });
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

  // ---------- events ----------

  listEvents(inboxId: string, q: ListEventsQuery = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.size ? `?${qs}` : "";
    return this.request<{ data: Event[]; next_cursor: string | null }>("GET", `${events(inboxId)}${suffix}`);
  }

  getEvent(inboxId: string, eventId: string) {
    return this.request<Event>("GET", `${events(inboxId)}/${enc(eventId)}`);
  }

  /** Claims the oldest pending event. `null` when nothing is available. */
  next(inboxId: string, opts: { ttl_seconds?: number } = {}) {
    return this.request<LockedEvent | null>("POST", `${events(inboxId)}/next`, opts);
  }

  lock(inboxId: string, eventId: string, opts: { ttl_seconds?: number; lock_token?: string } = {}) {
    return this.request<LockedEvent>("POST", `${events(inboxId)}/${enc(eventId)}/lock`, opts);
  }

  unlock(inboxId: string, eventId: string, lockToken: string) {
    return this.request<Event>("POST", `${events(inboxId)}/${enc(eventId)}/unlock`, { lock_token: lockToken });
  }

  processed(inboxId: string, eventId: string, opts: { lock_token?: string } = {}) {
    return this.request<Event>("POST", `${events(inboxId)}/${enc(eventId)}/processed`, opts);
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
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err;
      throw new ApiError(0, "network_error", `Could not reach ${this.baseUrl}: ${reason}`);
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, "bad_response", `Expected JSON from ${method} ${path}, got: ${text.slice(0, 200)}`);
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
const events = (inboxId: string) => `/inboxes/${enc(inboxId)}/events`;
