import type { CloudEvent } from "../cloudevents.js";

export interface IncomingWebhook {
  headers: Headers;
  /** Exact bytes as received (as a UTF-8 string) — signatures are computed over this. */
  rawBody: string;
  receivedAt: Date;
}

export type ReceiveResult =
  | { kind: "event"; event: CloudEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; status: 400 | 401 | 403 | 415 | 422; message: string };

/**
 * A source type defines how an inbox is configured and how a raw webhook becomes a CloudEvent.
 * Add a new one by implementing this and registering it in ./index.ts.
 */
export interface SourceAdapter<Config = unknown> {
  type: string;
  description: string;
  /** Validate user input on inbox create/update; fill defaults (e.g. generate a secret). Throws on invalid. */
  parseConfig(input: unknown, existing?: Config): Config;
  /** Shape of the config returned by the API. */
  publicConfig(config: Config): unknown;
  /** Setup hints shown on inbox responses (e.g. which content type to pick in GitHub). */
  setup?(config: Config, webhookUrl: string): Record<string, unknown>;
  receive(req: IncomingWebhook, config: Config): ReceiveResult | Promise<ReceiveResult>;
}
