// Helpers for picking values out of webhook payloads.
import { createHmac } from "node:crypto";

export type Payload = Record<string, unknown>;

/** Reads a dotted path (e.g. "deployment.id"; array indexes work too, e.g. "dnsNames.0"). */
export function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
}

/** The Standard Webhooks (Svix) signature of a delivery, as the `v1,<base64>` header value. `secret` is `whsec_<base64>`. */
export function standardWebhookSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}
