import { createHmac } from "node:crypto";
import { get, str } from "./payload.js";
import type { SourceAdapter, SourceDeps } from "./types.js";

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
 * so a source starts without one and its deliveries are refused until it's set.
 */

/** How far svix-timestamp may be from now, either way. */
const TOLERANCE_SECONDS = 5 * 60;

export const resend = ({ safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter => ({
  type: "resend",
  label: "Resend",
  description: "Resend email, contact and domain webhooks, verified with the svix-signature header.",
  secret: { from: "sender", pattern: /^whsec_[A-Za-z0-9+/]+={0,2}$/ },
  webhookSettings: "Resend → Webhooks",

  claims: (headers) => headers.has("svix-signature"),

  receive({ headers, rawBody, receivedAt }, secret) {
    const id = headers.get("svix-id");
    const timestamp = headers.get("svix-timestamp");
    const signatures = headers.get("svix-signature");
    if (!id || !timestamp || !signatures) {
      return { kind: "rejected", status: 401, message: "Missing svix-id, svix-timestamp or svix-signature header" };
    }

    const sentAt = Number(timestamp);
    if (!Number.isInteger(sentAt) || Math.abs(receivedAt.getTime() / 1000 - sentAt) > TOLERANCE_SECONDS) {
      return { kind: "rejected", status: 401, message: "svix-timestamp is too old or too far in the future" };
    }

    const key = Buffer.from(secret.slice("whsec_".length), "base64");
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
