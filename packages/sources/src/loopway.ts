import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import { firstLine, get, str, withText } from "./payload.js";
import type { SourceAdapter, SourceDeps } from "./types.js";

/**
 * Messages bots post to each other's inboxes. The body is `{type, id, data}`, checked against the
 * inbox's JSON Schema; `id` names the thing the message is about, so every message about the same
 * thing shares a subject (and a thread).
 *
 *   id      = a new UUID per message
 *   type    = body.type
 *   source  = the inbox's webhook URL
 *   subject = <type>/<id>
 *   time    = receive time
 *   data    = body.data
 *
 * Senders authenticate with the inbox's token: `Authorization: Bearer <token>`.
 */

export interface LoopwayConfig {
  /** The inbox token bots send as a bearer token. */
  secret: string;
  /** Message types to accept (e.g. ["build.finished"]). ["*"] accepts everything. */
  events: string[];
  /** JSON Schema (2020-12) every body must match. It must require `type`, `id` and `data`. */
  schema: JsonSchema;
}

type JsonSchema = Record<string, unknown>;

const MIN_SECRET = 16;
const REQUIRED = ["type", "id", "data"];

/** Accepts any value for the three required fields. */
export const DEFAULT_SCHEMA: JsonSchema = { type: "object", required: REQUIRED };

// `addUsedSchema: false` keeps inbox schemas that share an `$id` from clashing; `strict: false`
// ignores keywords and formats ajv doesn't know rather than refusing the schema.
const ajv = new Ajv2020({ strict: false, addUsedSchema: false, logger: false });
/** Compiled validators by schema JSON, so each schema compiles once per process. */
const validators = new Map<string, ValidateFunction>();

function validator(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(key, validate);
  }
  return validate;
}

const schemaInput = z
  .record(z.string(), z.unknown())
  .refine((s) => Array.isArray(s.required) && REQUIRED.every((f) => (s.required as unknown[]).includes(f)), {
    message: `schema.required must include ${REQUIRED.join(", ")}`,
  })
  .superRefine((s, ctx) => {
    try {
      validator(s);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

const configInput = z
  .object({
    secret: z.string().min(MIN_SECRET, `secret must be at least ${MIN_SECRET} characters`).optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
    schema: schemaInput.optional(),
  })
  .strict();

export const loopway = ({
  newSecret,
  safeEqual,
  uuidv7,
  makeCloudEvent,
}: SourceDeps): SourceAdapter<LoopwayConfig> => ({
  type: "loopway",
  label: "Loopway",
  typePrefix: "",
  description: "Messages from your own bots and backends, checked against the inbox's JSON Schema.",
  events: [],
  secret: { from: "loopway", minLength: MIN_SECRET },
  webhookSettings: "the bot or backend that sends messages",

  parseConfig(input, existing) {
    const parsed = configInput.parse(input ?? {});
    return {
      secret: parsed.secret ?? existing?.secret ?? newSecret(),
      events: parsed.events ?? existing?.events ?? ["*"],
      schema: parsed.schema ?? existing?.schema ?? DEFAULT_SCHEMA,
    };
  },

  publicConfig(config) {
    return { secret: config.secret, events: config.events, schema: config.schema };
  },

  setup(config, webhookUrl) {
    return {
      endpoint_url: webhookUrl,
      headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
      body: '{"type": "…", "id": "…", "data": …}, matching the inbox schema',
      events: config.events.includes("*") ? "Any" : config.events,
    };
  },

  // The types the inbox accepts, so a filter never leaves it without one; the first is the default.
  sampleTypes: (config) => ["test", ...config.events.filter((e) => e !== "*" && e !== "test")],

  sample(config, { type }) {
    return {
      headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
      rawBody: JSON.stringify({ type, id: "test-1", data: { message: "A test message from loopway" } }),
    };
  },

  summarize(event) {
    const id = event.subject?.slice(event.type.length + 1);
    return withText(id ? `${event.type} ${id}` : event.type, str(get(event.data, "title")));
  },

  title(event) {
    return firstLine(str(get(event.data, "title"))) ?? null;
  },

  receive({ headers, rawBody, receivedAt, webhookUrl }, config) {
    const token = headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim();
    if (!token) return { kind: "rejected", status: 401, message: "Missing Authorization: Bearer <inbox token>" };
    if (!safeEqual(token, config.secret)) return { kind: "rejected", status: 401, message: "Wrong inbox token" };

    const contentType = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/json") {
      return { kind: "rejected", status: 415, message: "Unsupported content type; use application/json" };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { kind: "rejected", status: 400, message: "Body must be JSON" };
    }
    const validate = validator(config.schema);
    if (!validate(body)) {
      const e = validate.errors?.[0];
      const message = e ? `${e.instancePath || "body"} ${e.message ?? "is invalid"}` : "is invalid";
      return { kind: "rejected", status: 400, message: `Doesn't match the inbox schema: ${message}` };
    }

    // The schema can allow anything for these, but the CloudEvent needs a type and a subject.
    const { type, id, data } = body as { type: unknown; id: unknown; data: unknown };
    if (typeof type !== "string" || !type) {
      return { kind: "rejected", status: 400, message: "`type` must be a non-empty string" };
    }
    if ((typeof id !== "string" || !id) && typeof id !== "number") {
      return { kind: "rejected", status: 400, message: "`id` must be a non-empty string or a number" };
    }
    // Bots route this type straight to the thread in `data.thread_id` as a person's message (see THREAD_MESSAGE_TYPE
    // in @loopway/rules), so only a member's `POST /bots/:id/threads/:id/messages` may make one.
    if (type === "dev.loopway.thread.message") {
      return { kind: "rejected", status: 422, message: `event "${type}" is reserved for messages sent to a thread` };
    }
    if (!config.events.includes("*") && !config.events.includes(type)) {
      return { kind: "rejected", status: 422, message: `event "${type}" not enabled for this inbox` };
    }

    return {
      kind: "event",
      event: makeCloudEvent({
        specversion: "1.0",
        id: uuidv7(receivedAt.getTime()),
        source: webhookUrl,
        type,
        subject: `${type}/${id}`,
        time: receivedAt.toISOString(),
        datacontenttype: "application/json",
        data,
      }),
    };
  },
});
