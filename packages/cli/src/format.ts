import { stripVTControlCharacters, styleText } from "node:util";
import type { EventStatus } from "./client.js";

// styleText drops the colors itself when stdout isn't a TTY or NO_COLOR is set.
export const bold = (s: string) => styleText("bold", s);
export const dim = (s: string) => styleText("dim", s);
export const red = (s: string) => styleText("red", s);
export const cyan = (s: string) => styleText("cyan", s);

const STATUS_COLOR = { pending: "yellow", locked: "cyan", processed: "green" } as const;
export const status = (s: EventStatus) => styleText(STATUS_COLOR[s] ?? "reset", s);

export function table(headers: string[], rows: string[][]): string {
  const all = [headers.map((h) => bold(h)), ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visible(r[i] ?? ""))));
  return all
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(widths[i]! - visible(cell))))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** "label  value" lines with the labels aligned. Undefined/null values are skipped. */
export function fields(pairs: [string, string | number | null | undefined][]): string {
  const kept = pairs.filter((p): p is [string, string | number] => p[1] != null && p[1] !== "");
  const width = Math.max(0, ...kept.map(([k]) => k.length));
  return kept.map(([k, v]) => `${dim(k.padEnd(width))}  ${v}`).join("\n");
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  const abs = Math.abs(s);
  const [n, unit] =
    abs < 60 ? [abs, "s"] : abs < 3600 ? [abs / 60, "m"] : abs < 86400 ? [abs / 3600, "h"] : [abs / 86400, "d"];
  const v = `${Math.floor(n)}${unit}`;
  return s >= 0 ? `${v} ago` : `in ${v}`;
}

/** payload_url → "Payload URL" */
export function humanize(key: string): string {
  const s = key.replace(/_/g, " ").replace(/\b(url|id)\b/gi, (m) => m.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const json = (v: unknown) => JSON.stringify(v, null, 2);

const visible = (s: string) => stripVTControlCharacters(s).length;
