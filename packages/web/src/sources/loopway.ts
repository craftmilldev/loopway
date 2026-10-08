import { z } from "zod";
import { makeCloudEvent } from "../cloudevents.js";
import type { SourceAdapter } from "./types.js";

/**
 * CloudEvents posted by bots, so they can send each other work through inboxes. The body is a
 * structured-mode CloudEvent and is stored as sent: https://github.com/cloudevents/spec
 *
 *   id, source, type, subject, data = as sent
 *   time                            = as sent, falling back to receive time
 *
 * There's no webhook secret. The sender authenticates with a loopway API token
 * (`Authorization: Bearer …`); any loopway user's token is accepted.
 */

export interface LoopwayConfig {
  /** CloudEvent types to accept (e.g. ["com.example.build.finished"]). ["*"] accepts everything. */
  events: string[];
}

const configInput = z
  .object({
    events: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const CONTENT_TYPES = ["application/cloudevents+json", "application/json"];

// Other keys are CloudEvents extension attributes; makeCloudEvent checks their names.
const eventInput = z
  .object({
    specversion: z.literal("1.0").optional(),
    id: z.string().min(1),
    source: z.string().min(1),
    type: z.string().min(1),
    subject: z.string().min(1).optional(),
    time: z.iso.datetime({ offset: true }).optional(),
    datacontenttype: z.string().min(1).optional(),
    dataschema: z.string().min(1).optional(),
    data: z.unknown().optional(),
  })
  .catchall(z.unknown());

export const loopway: SourceAdapter<LoopwayConfig> = {
  type: "loopway",
  label: "Loopway",
  description: "CloudEvents your own bots post, authenticated with a loopway API token.",
  events: [],
  secret: { from: "none" },
  webhookSettings: "the bot that sends events",

  parseConfig(input, existing) {
    const parsed = configInput.parse(input ?? {});
    return { events: parsed.events ?? existing?.events ?? ["*"] };
  },

  publicConfig(config) {
    return { events: config.events };
  },

  setup(config, webhookUrl) {
    return {
      endpoint_url: webhookUrl,
      headers: { authorization: "Bearer <loopway API token>", "content-type": "application/cloudevents+json" },
      body: '{"specversion": "1.0", "id": "…", "source": "…", "type": "…", "data": {…}}',
      events: config.events.includes("*") ? "Any" : config.events,
    };
  },

  async receive(req, config) {
    const { headers, rawBody, receivedAt } = req;
    if (!(await req.user())) {
      return { kind: "rejected", status: 401, message: "Missing or invalid loopway API token" };
    }

    const contentType = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!CONTENT_TYPES.includes(contentType)) {
      return { kind: "rejected", status: 415, message: `Unsupported content type; use ${CONTENT_TYPES.join(" or ")}` };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { kind: "rejected", status: 400, message: "Body must be JSON" };
    }
    const parsed = eventInput.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid CloudEvent";
      return { kind: "rejected", status: 400, message: `Not a CloudEvent: ${message}` };
    }

    const e = parsed.data;
    if (!config.events.includes("*") && !config.events.includes(e.type)) {
      return { kind: "rejected", status: 422, message: `event "${e.type}" not enabled for this inbox` };
    }

    try {
      return {
        kind: "event",
        event: makeCloudEvent({
          ...e,
          specversion: "1.0",
          time: e.time ? new Date(e.time).toISOString() : receivedAt.toISOString(),
        }),
      };
    } catch (err) {
      return { kind: "rejected", status: 400, message: err instanceof Error ? err.message : "Invalid CloudEvent" };
    }
  },
};
