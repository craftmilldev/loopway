import { createHmac } from "node:crypto";
import { get, str, type Payload } from "./payload.js";
import type { SourceAdapter, SourceDeps } from "./types.js";

/**
 * Linear webhooks → CloudEvents. Linear sends `{action, type, data, url, createdAt, organizationId, webhookId, ...}`
 * with the delivery id in `Linear-Delivery`: https://linear.app/developers/webhooks
 *
 *   id      = Linear-Delivery header, falling back to webhookTimestamp + data.id
 *   type    = com.linear.<type>.<action>, lowercased (e.g. com.linear.issue.create, com.linear.comment.update)
 *   source  = https://linear.app, with the organization id as a path when there is one
 *   subject = the issue the event is about: data.issueId for comments, else data.id
 *   time    = body.createdAt, falling back to receive time
 *   data    = the whole webhook body
 */

export const linear = ({ safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter => ({
  type: "linear",
  label: "Linear",
  description: "Linear webhooks, verified with Linear-Signature.",
  // Linear makes the secret when the webhook is added, so it's set afterwards.
  secret: { from: "sender" },
  webhookSettings: "Linear → Settings → API → Webhooks",

  claims: (headers) => headers.has("linear-signature"),

  receive({ headers, rawBody, receivedAt }, secret) {
    const signature = headers.get("linear-signature");
    if (!signature) return { kind: "rejected", status: 401, message: "Missing Linear-Signature header" };
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    if (!safeEqual(signature, expected)) return { kind: "rejected", status: 401, message: "Signature mismatch" };

    let body: Payload;
    try {
      const value: unknown = JSON.parse(rawBody);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      body = value as Payload;
    } catch {
      return { kind: "rejected", status: 400, message: "Body must be a JSON object" };
    }

    const resource = str(body.type);
    const action = str(body.action);
    if (!resource || !action) return { kind: "rejected", status: 400, message: "Missing `type` or `action` in body" };
    const name = `${resource}.${action}`.toLowerCase();

    const dataId = str(get(body, "data.id"));
    const id = headers.get("linear-delivery") ?? (dataId ? `${str(body.webhookTimestamp) ?? ""}${dataId}` : undefined);
    if (!id) return { kind: "rejected", status: 400, message: "Missing Linear-Delivery header" };

    const org = str(body.organizationId);
    const subject = str(get(body, "data.issueId")) ?? dataId ?? id;
    const time = toIso(body.createdAt) ?? receivedAt.toISOString();

    return {
      kind: "event",
      event: makeCloudEvent({
        specversion: "1.0",
        id,
        source: org ? `https://linear.app/${org}` : "https://linear.app",
        type: `com.linear.${name}`,
        subject,
        time,
        datacontenttype: "application/json",
        data: body,
      }),
    };
  },
});

function toIso(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
