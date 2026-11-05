/** CloudEvents v1.0, structured-mode JSON representation. https://github.com/cloudevents/spec */
export interface CloudEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  time?: string;
  datacontenttype?: string;
  dataschema?: string;
  data?: unknown;
  /** Extension attributes: lowercase a-z0-9, max 20 chars. */
  [extension: string]: unknown;
}

/**
 * What sources need from their host but don't own: ids, secrets, signature comparison and CloudEvent
 * validation. The host passes them in, so tests can pin them and get the same output every time.
 */
export interface SourceDeps {
  /** A time-ordered UUID for the given time. */
  uuidv7: (now?: number) => string;
  /** Constant-time string comparison. */
  safeEqual: (a: string, b: string) => boolean;
  /** Validates the required attributes and drops empty ones. Throws on an invalid event. */
  makeCloudEvent: (e: CloudEvent) => CloudEvent;
}

export interface IncomingWebhook {
  headers: Headers;
  /** Exact bytes as received (as a UTF-8 string) — signatures are computed over this. */
  rawBody: string;
  receivedAt: Date;
  /** The user's inbox URL, the one this request was sent to. */
  webhookUrl: string;
}

export type ReceiveResult =
  | { kind: "event"; event: CloudEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; status: 400 | 401 | 403 | 404 | 415 | 422; message: string };

/**
 * Who makes the webhook signing secret:
 * - `loopway`: loopway generates one (or takes one of at least `minLength` characters) and you enter it in the sender.
 * - `sender`: the sender shows one after the webhook is added there, and you register it afterwards. Until then the
 *   source's deliveries are refused. `pattern`, if any, is what a good one looks like.
 * - `none`: the source has no secret and takes no webhooks; it fills itself (see `tick`).
 */
export type SecretOrigin =
  { from: "loopway"; minLength: number } | { from: "sender"; pattern?: RegExp } | { from: "none" };

/**
 * A source type says how to recognise a sender's deliveries, how to verify them, and how to turn them into CloudEvents.
 * Add one by implementing this and registering it in ./index.ts. The API and the CLI only read what's here.
 */
export interface SourceAdapter<Config = unknown> {
  type: string;
  /** Display name, e.g. "GitHub". */
  label: string;
  description: string;
  secret: SecretOrigin;
  /** Where in the sender the webhook is added, e.g. "GitHub → Settings → Webhooks". */
  webhookSettings: string;
  /** Whether a delivery looks like it came from this sender, from its headers alone. Sources without webhooks have none. */
  claims?(headers: Headers): boolean;
  /** Verifies a delivery against one stored secret and maps it. A signature that doesn't match is a 401. */
  receive?(req: IncomingWebhook, secret: string): ReceiveResult | Promise<ReceiveResult>;
  /** For sources with settings of their own: validates them. Throws on invalid. */
  parseConfig?(input: unknown, existing?: Config): Config;
  /** For sources that fill themselves on a clock: the events due at `now`. The server's cron route stores them; repeats must dedupe (same CE source and id). */
  tick?(config: Config, sourceId: string, now: Date): CloudEvent[];
}
