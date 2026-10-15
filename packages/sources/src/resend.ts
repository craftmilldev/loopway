import { createHmac } from "node:crypto";
import { z } from "zod";
import { firstLine, get, str, withText } from "./payload.js";
import type { CloudEvent, SourceAdapter, SourceDeps } from "./types.js";

/** What the event is about: an email's subject line, a contact's address or a domain's name. */
const label = (event: CloudEvent) =>
  str(get(event.data, "data.subject")) ?? str(get(event.data, "data.email")) ?? str(get(event.data, "data.name"));

/**
 * Resend webhooks → CloudEvents. Resend signs with Svix (the Standard Webhooks scheme under svix-* headers):
 * https://resend.com/docs/webhooks/introduction
 *
 *   id      = svix-id
 *   type    = com.resend.<type>, e.g. com.resend.email.bounced
 *   source  = https://api.resend.com/emails/<email_id> (https://api.resend.com for contacts and domains)
 *   subject = the email, contact or domain id, when there is one
 *   time    = created_at, falling back to receive time
 *   data    = the webhook payload
 *
 * Resend generates the signing secret when the webhook is created, after it already needs our URL,
 * so an inbox starts without one and rejects deliveries until it's set.
 */

export interface ResendConfig {
  /** Signing secret Resend shows for the webhook (`whsec_…`). */
  secret: string | null;
  /** Resend event types to accept (e.g. ["email.bounced"]). ["*"] accepts everything. */
  events: string[];
}

export const RESEND_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
];

/** How far svix-timestamp may be from now, either way. */
const TOLERANCE_SECONDS = 5 * 60;

const configInput = z
  .object({
    secret: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, "secret must be the whsec_… signing secret Resend shows")
      .optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const resend = ({ safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter<ResendConfig> => ({
  type: "resend",
  label: "Resend",
  description: "Resend email, contact and domain webhooks, verified with the svix-signature header.",
  events: RESEND_EVENTS,
  secret: { from: "sender" },
  webhookSettings: "Resend → Webhooks",

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
      where: "Resend → Webhooks → Add Webhook",
      endpoint_url: webhookUrl,
      events: config.events.includes("*") ? RESEND_EVENTS : config.events,
      secret: config.secret
        ? "set"
        : "not set yet: paste the whsec_… signing secret Resend shows on the inbox page, or run `loopway inbox update <inbox> --secret whsec_…`",
    };
  },

  summarize(event) {
    return withText(`Resend ${event.type.replace(/^com\.resend\./, "").replace(/[._]/g, " ")}`, label(event));
  },

  title(event) {
    return firstLine(label(event)) ?? null;
  },

  receive({ headers, rawBody, receivedAt }, config) {
    if (!config.secret) return { kind: "rejected", status: 401, message: "No signing secret set for this inbox yet" };

    const id = headers.get("svix-id");
    const timestamp = headers.get("svix-timestamp");
    const signatures = headers.get("svix-signature");
    if (!id || !timestamp || !signatures) {
      return { kind: "rejected", status: 400, message: "Missing svix-id, svix-timestamp or svix-signature header" };
    }

    const sentAt = Number(timestamp);
    if (!Number.isInteger(sentAt) || Math.abs(receivedAt.getTime() / 1000 - sentAt) > TOLERANCE_SECONDS) {
      return { kind: "rejected", status: 401, message: "svix-timestamp is too old or too far in the future" };
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

    const eventType = payload.type;
    if (typeof eventType !== "string" || !eventType) {
      return { kind: "rejected", status: 400, message: "Payload is missing type" };
    }
    if (!config.events.includes("*") && !config.events.includes(eventType)) {
      return { kind: "rejected", status: 422, message: `event "${eventType}" not enabled for this inbox` };
    }

    const created = typeof payload.created_at === "string" ? new Date(payload.created_at) : undefined;
    const time = created && !Number.isNaN(created.getTime()) ? created : receivedAt;
    const emailId = str(get(payload, "data.email_id"));
    const subject = emailId ?? str(get(payload, "data.id"));

    return {
      kind: "event",
      event: makeCloudEvent({
        specversion: "1.0",
        id,
        source: emailId ? `https://api.resend.com/emails/${encodeURIComponent(emailId)}` : "https://api.resend.com",
        type: `com.resend.${eventType}`,
        ...(subject ? { subject } : {}),
        time: time.toISOString(),
        datacontenttype: "application/json",
        data: payload,
      }),
    };
  },
});
