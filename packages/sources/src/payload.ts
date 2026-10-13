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

const LINE_MAX = 80;

/** First non-empty line of `text`, whitespace collapsed and cut to a line's length. */
export function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > LINE_MAX ? line.slice(0, LINE_MAX - 1).trimEnd() + "…" : line;
}

/** `head`, then `: ` and the first line of `text` when there is one. */
export function withText(head: string, text: string | undefined): string {
  const line = firstLine(text);
  return line ? `${head}: ${line}` : head;
}
