// Helpers for picking values out of webhook payloads.

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
