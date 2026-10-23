import { createHmac } from "node:crypto";
import { z } from "zod";
import { firstLine, get, standardWebhookSignature, str, withText } from "./payload.js";
import type { CloudEvent, SourceAdapter, SourceDeps } from "./types.js";

/** The note's title, when the webhook carries one. */
const noteTitle = (event: CloudEvent) => str(get(event.data, "title")) ?? str(get(event.data, "note.title"));

/**
 * Granola webhooks → CloudEvents. Granola signs with the Standard Webhooks scheme:
 * https://docs.granola.ai/webhooks
 *
 *   id      = webhook-id (= event_id)
 *   type    = ai.granola.<event_type>, e.g. ai.granola.note.generated
 *   source  = https://public-api.granola.ai/v1/notes/<note_id> (GET it for the note's content)
 *   subject = note_id
 *   time    = occurred_at, falling back to receive time
 *   data    = the webhook payload
 *
 * Granola generates the signing secret when the webhook is created, after it already needs our URL,
 * so an inbox starts without one and rejects deliveries until it's set.
 */

export interface GranolaConfig {
  /** Signing secret Granola shows when the webhook is created (`whsec_…`). */
  secret: string | null;
  /** Granola event types to accept (e.g. ["note.generated"]). ["*"] accepts everything. */
  events: string[];
}

export const GRANOLA_EVENTS = ["note.generated", "note.edited", "note.access_granted"];

/** How far webhook-timestamp may be from now, either way. */
const TOLERANCE_SECONDS = 5 * 60;

const configInput = z
  .object({
    secret: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, "secret must be the whsec_… signing secret Granola shows")
      .optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const granola = ({ safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter<GranolaConfig> => ({
  type: "granola",
  label: "Granola",
  description: "Granola note webhooks (Business/Enterprise plans), verified with the webhook-signature header.",
  events: GRANOLA_EVENTS,
  secret: { from: "sender" },
  webhookSettings: "Granola → Settings → Connectors → Webhooks",

  parseConfig(input, existing) {
    const parsed = configInput.parse(input ?? {});
    return {
      secret: parsed.secret ?? existing?.secret ?? null,
      events: parsed.events ?? existing?.events ?? ["*"],
    };
  },

  publicConfig(config) {
    return { secret: config.secret, events: config.events };
  },

  setup(config, webhookUrl) {
    return {
      where: "Granola → Settings → Connectors → Webhooks → Set up a webhook",
      endpoint_url: webhookUrl,
      events: config.events.includes("*") ? GRANOLA_EVENTS : config.events,
      secret: config.secret
        ? "set"
        : "not set yet: paste the whsec_… secret Granola shows on the inbox page, or run `loopway inbox update <inbox> --secret whsec_…`",
    };
  },

  sampleTypes: () => GRANOLA_EVENTS,

  sample(config, { type, id, now }) {
    const rawBody = JSON.stringify({
      event_id: id,
      event_type: type,
      note_id: "not_loopwaytest00",
      title: "A test note from loopway",
      occurred_at: now.toISOString(),
    });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    return {
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": standardWebhookSignature(config.secret!, id, timestamp, rawBody),
      },
      rawBody,
    };
  },

  summarize(event) {
    return withText(`Granola ${event.type.replace(/^ai\.granola\./, "").replace(/[._]/g, " ")}`, noteTitle(event));
  },

  title(event) {
    return firstLine(noteTitle(event)) ?? null;
  },

  receive({ headers, rawBody, receivedAt }, config) {
    if (!config.secret) return { kind: "rejected", status: 401, message: "No signing secret set for this inbox yet" };

    const id = headers.get("webhook-id");
    const timestamp = headers.get("webhook-timestamp");
    const signatures = headers.get("webhook-signature");
    if (!id || !timestamp || !signatures) {
      return {
        kind: "rejected",
        status: 400,
        message: "Missing webhook-id, webhook-timestamp or webhook-signature header",
      };
    }

    const sentAt = Number(timestamp);
    if (!Number.isInteger(sentAt) || Math.abs(receivedAt.getTime() / 1000 - sentAt) > TOLERANCE_SECONDS) {
      return { kind: "rejected", status: 401, message: "webhook-timestamp is too old or too far in the future" };
    }

    const key = Buffer.from(config.secret.slice("whsec_".length), "base64");
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest("base64");
    // Space-separated `v1,<base64>` entries; more than one while a secret is being rotated.
    const ok = signatures.split(" ").some((s) => s.startsWith("v1,") && safeEqual(s.slice(3), expected));
    if (!ok) return { kind: "rejected", status: 401, message: "Signature mismatch" };

    let payload: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(rawBody);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      payload = value as Record<string, unknown>;
    } catch {
      return { kind: "rejected", status: 400, message: "Payload must be a JSON object" };
    }

    const eventType = payload.event_type;
    const noteId = payload.note_id;
    if (typeof eventType !== "string" || !eventType || typeof noteId !== "string" || !noteId) {
      return { kind: "rejected", status: 400, message: "Payload is missing event_type or note_id" };
    }
    if (!config.events.includes("*") && !config.events.includes(eventType)) {
      return { kind: "rejected", status: 422, message: `event "${eventType}" not enabled for this inbox` };
    }

    const occurred = typeof payload.occurred_at === "string" ? new Date(payload.occurred_at) : undefined;
    const time = occurred && !Number.isNaN(occurred.getTime()) ? occurred : receivedAt;

    return {
      kind: "event",
      event: makeCloudEvent({
        specversion: "1.0",
        id,
        source: `https://public-api.granola.ai/v1/notes/${encodeURIComponent(noteId)}`,
        type: `ai.granola.${eventType}`,
        subject: noteId,
        time: time.toISOString(),
        datacontenttype: "application/json",
        data: payload,
      }),
    };
  },
});
