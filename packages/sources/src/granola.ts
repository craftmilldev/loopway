import { createHmac } from "node:crypto";
import type { SourceAdapter, SourceDeps } from "./types.js";

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
 * so a source starts without one and its deliveries are refused until it's set.
 */

/** How far webhook-timestamp may be from now, either way. */
const TOLERANCE_SECONDS = 5 * 60;

export const granola = ({ safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter => ({
  type: "granola",
  label: "Granola",
  description: "Granola note webhooks (Business/Enterprise plans), verified with the webhook-signature header.",
  secret: { from: "sender", pattern: /^whsec_[A-Za-z0-9+/]+={0,2}$/ },
  webhookSettings: "Granola → Settings → Connectors → Webhooks",

  claims: (headers) => headers.has("webhook-signature"),

  receive({ headers, rawBody, receivedAt }, secret) {
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

    const eventType = payload.event_type;
    const noteId = payload.note_id;
    // A signed delivery about no note is Granola's "send a test event" (its shape isn't documented): acknowledge it
    // like GitHub's ping, so the dialog shows success, and name its event_type in the outcome.
    if (typeof noteId !== "string" || !noteId) {
      const kind = typeof eventType === "string" ? eventType.replace(/[^\w.-]/g, "").slice(0, 64) : "";
      return { kind: "ignored", reason: kind ? `no_note:${kind}` : "no_note" };
    }
    if (typeof eventType !== "string" || !eventType) {
      return { kind: "rejected", status: 400, message: "Payload is missing event_type" };
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
