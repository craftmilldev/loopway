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
  /** A fresh webhook signing secret. */
  newSecret: () => string;
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
  /** The inbox's webhook URL, the one this request was sent to. */
  webhookUrl: string;
}

export type ReceiveResult =
  | { kind: "event"; event: CloudEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; status: 400 | 401 | 403 | 415 | 422; message: string };

/**
 * Who makes the webhook signing secret:
 * - `loopway`: loopway generates one (or takes one of at least `minLength` characters) and you enter it in the sender.
 * - `sender`: the sender shows one after the webhook is added there, and it's pasted into the inbox afterwards.
 *   The inbox rejects deliveries until then.
 */
export type SecretOrigin = { from: "loopway"; minLength: number } | { from: "sender" };

/**
 * A source type defines how an inbox is configured and how a raw webhook becomes a CloudEvent.
 * Add a new one by implementing this and registering it in ./index.ts. The API, the CLI and the
 * dashboard only read what's here, so nothing else needs to change.
 */
export interface SourceAdapter<Config = unknown> {
  type: string;
  /** Display name, e.g. "GitHub". */
  label: string;
  description: string;
  /** Common event names, offered as choices when creating an inbox. Others can still be typed in. */
  events: string[];
  secret: SecretOrigin;
  /** Where in the sender the webhook is added, e.g. "GitHub → Settings → Webhooks". */
  webhookSettings: string;
  /** Validate user input on inbox create/update; fill defaults (e.g. generate a secret). Throws on invalid. */
  parseConfig(input: unknown, existing?: Config): Config;
  /** Shape of the config returned by the API. */
  publicConfig(config: Config): unknown;
  /** Setup hints shown on inbox responses (e.g. which content type to pick in GitHub). */
  setup?(config: Config, webhookUrl: string): Record<string, unknown>;
  /** One line on what the event is, e.g. "alice commented on #12: Looks good". Null when there's nothing to say. */
  summarize(event: CloudEvent): string | null;
  /** The title of the thing the event is about (an issue or pull request), for a thread's title. Null if it has none. */
  title(event: CloudEvent): string | null;
  /** Whether a person or a bot made the event, from its metadata. Null if the source can't tell, or has no author. */
  author?(event: CloudEvent): "human" | "bot" | null;
  receive(req: IncomingWebhook, config: Config): ReceiveResult | Promise<ReceiveResult>;
}
