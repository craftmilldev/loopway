// Typed client for the loopway HTTP API (see docs/api.md for the contract).

import { CLI_VERSION, VERSION_HEADER } from "./version.js";

export interface User {
  id: string;
  name: string;
  email: string | null;
  /** Null only for accounts from before signup asked for one. */
  username: string | null;
  created_at: string;
}

export interface SourceType {
  type: string;
  label: string;
  description: string;
  /** `loopway`: generated or given when registering. `sender`: the sender makes it, and it's given afterwards. */
  secret: { from: "loopway"; min_length: number } | { from: "sender" } | { from: "none" };
  /** Where in the sender the webhook is added. */
  webhook_settings: string;
}

export interface RegisteredSource {
  id: string;
  name: string;
  type: string;
  /** A schedule's settings. */
  config?: unknown;
  /** Whether a signing secret is stored. Missing for a source that takes no webhooks. */
  secret_set?: boolean;
  webhook_url?: string;
  webhook_settings: string;
  created_at: string;
  /** When a delivery last verified against the source, and what came of it; null until one has. */
  last_delivery_at: string | null;
  last_delivery_outcome: string | null;
  /** The secret loopway generated, on the response that made it. Nowhere else. */
  secret?: string;
}

export interface Inbox {
  url: string;
  sources: number;
  messages: number;
  retention_days: number;
}

export interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
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
  /** The source that verified it; null for a message pushed by a user, or whose source has since been removed. */
  source_id: string | null;
  /** ISO 8601, to the microsecond. */
  received_at: string;
  /** Microseconds since the epoch: what a `since` is. */
  received_us: string;
  event: CloudEvent;
}

export interface ReadQuery {
  /** `now`, microseconds since the epoch, or an ISO 8601 time. Inclusive. */
  since?: string;
  /** The `next_after` that came with this `since`. */
  after?: string;
  limit?: number;
  /** An exact CloudEvent type, or a prefix ending in `*`. */
  type?: string;
  /** `desc` is the newest messages, for looking: it has no cursor. */
  order?: "asc" | "desc";
}

export interface ReadResult {
  data: Message[];
  next_since: string | null;
  next_after: string | null;
  has_more: boolean;
}

export interface PushInput {
  type: string;
  subject?: string;
  /** A dedupe id: pushing it again stores nothing new. */
  id?: string;
  data?: unknown;
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

  /** Sets or changes the username. 400/409 `invalid_username`, `username_reserved`, `username_taken`. */
  setUsername(username: string) {
    return this.request<User>("PATCH", "/me/username", { username });
  }

  inbox() {
    return this.request<Inbox>("GET", "/inbox");
  }

  // ---------- sources ----------

  async sourceTypes() {
    return (await this.request<{ data: SourceType[] }>("GET", "/source-types")).data;
  }

  async listSources() {
    return (await this.request<{ data: RegisteredSource[] }>("GET", "/sources")).data;
  }

  getSource(id: string) {
    return this.request<RegisteredSource>("GET", `/sources/${enc(id)}`);
  }

  registerSource(input: { type: string; name?: string; secret?: string; config?: unknown }) {
    return this.request<RegisteredSource>("POST", "/sources", input);
  }

  updateSource(id: string, input: { name?: string; secret?: string; config?: unknown }) {
    return this.request<RegisteredSource>("PATCH", `/sources/${enc(id)}`, input);
  }

  async removeSource(id: string) {
    await this.request("DELETE", `/sources/${enc(id)}`);
  }

  // ---------- messages ----------

  readMessages(q: ReadQuery = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.size ? `?${qs}` : "";
    return this.request<ReadResult>("GET", `/messages${suffix}`);
  }

  getMessage(id: string) {
    return this.request<Message>("GET", `/messages/${enc(id)}`);
  }

  pushMessage(input: PushInput) {
    return this.request<{ id: string; duplicate: boolean }>("POST", "/messages", input);
  }

  // ---------- tokens ----------

  async listTokens() {
    return (await this.request<{ data: ApiToken[] }>("GET", "/tokens")).data;
  }

  createToken(name: string) {
    return this.request<ApiToken & { token: string }>("POST", "/tokens", { name });
  }

  async revokeToken(id: string) {
    await this.request("DELETE", `/tokens/${enc(id)}`);
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
