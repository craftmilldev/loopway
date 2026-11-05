import type { SourceAdapter, SourceDeps } from "./types.js";

/**
 * Messages from anything that can make an HTTP request and hold a token: a script, a CI job, a service with no signed
 * webhooks of its own. The body is `{type, id, data}`, where `id` names the thing the message is about.
 *
 *   id      = a new UUID per message
 *   type    = body.type
 *   source  = the user's inbox URL
 *   subject = <type>/<id>
 *   time    = receive time
 *   data    = body.data
 *
 * Senders authenticate with the source's token: `Authorization: Bearer <token>`.
 */

const MIN_SECRET = 16;
const MAX_BODY = 1024 * 1024;

export const loopway = ({ uuidv7, safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter => ({
  type: "loopway",
  label: "loopway",
  description: "Messages you send yourself, with a token this source holds.",
  secret: { from: "loopway", minLength: MIN_SECRET },
  webhookSettings: "your own script: POST {type, id, data} with Authorization: Bearer <token>",

  claims: (headers) => /^Bearer\s/i.test(headers.get("authorization") ?? ""),

  receive({ headers, rawBody, receivedAt, webhookUrl }, secret) {
    const token = headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim();
    if (!token) return { kind: "rejected", status: 401, message: "Missing Authorization: Bearer <token>" };
    if (!safeEqual(token, secret)) return { kind: "rejected", status: 401, message: "Wrong token" };

    if (Buffer.byteLength(rawBody) > MAX_BODY) {
      return { kind: "rejected", status: 400, message: `Body must be at most ${MAX_BODY} bytes` };
    }

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
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { kind: "rejected", status: 400, message: "Body must be a JSON object" };
    }

    const { type, id, data } = body as { type: unknown; id: unknown; data: unknown };
    if (typeof type !== "string" || !type) {
      return { kind: "rejected", status: 400, message: "`type` must be a non-empty string" };
    }
    if ((typeof id !== "string" || !id) && typeof id !== "number") {
      return { kind: "rejected", status: 400, message: "`id` must be a non-empty string or a number" };
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
