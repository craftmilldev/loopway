// Typed client for the loopway HTTP API (see docs/api.md for the contract).

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

export interface Inbox {
  id: string;
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

  async sources() {
    return (await this.request<{ data: Source[] }>("GET", "/sources")).data;
  }

  // ---------- inboxes ----------

  /** The inboxes of one org (by slug). */
  async listInboxes() {
    return (await this.request<{ data: Inbox[] }>("GET", `/inboxes`)).data;
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
