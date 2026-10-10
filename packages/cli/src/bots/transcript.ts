import { join } from "node:path";

/** Where a thread's transcript goes: ~/.loopway/threads/<thread>.log */
export const sessionLogPath = (dir: string, threadId: string) => join(dir, "threads", `${threadId}.log`);

/** One line of a session transcript as the TUI shows it. */
export interface TranscriptLine {
  text: string;
  kind: "text" | "tool" | "result" | "error" | "meta";
}

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | Block[];
  is_error?: boolean;
}

interface LogRecord {
  type?: string;
  subtype?: string;
  /** Set on a subagent's messages; only the session's own turns are shown. */
  parent_tool_use_id?: string | null;
  message?: { content?: string | Block[] };
  duration_ms?: number;
  total_cost_usd?: number;
}

/**
 * Turns a session log (Claude Code's stream-json, plus anything it wrote to stderr) into readable
 * lines: assistant text, one line per tool call, the start of each tool result, and a line per run.
 */
export function transcriptLines(log: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of log.split("\n")) {
    if (!raw.trim()) continue;
    let r: LogRecord;
    try {
      r = JSON.parse(raw) as LogRecord;
    } catch {
      lines.push({ text: raw, kind: "error" });
      continue;
    }
    if (r.parent_tool_use_id) continue;
    if (r.type === "system" && r.subtype === "init") lines.push({ text: "── run started ──", kind: "meta" });
    else if (r.type === "result")
      lines.push({ text: `── run ${r.subtype === "success" ? "finished" : r.subtype} ${runStats(r)}──`, kind: "meta" });
    else if (r.type === "assistant" || r.type === "user") {
      for (const b of blocks(r.message?.content)) lines.push(...blockLines(r.type, b));
    }
  }
  return lines;
}

function blockLines(role: string, b: Block): TranscriptLine[] {
  if (b.type === "text" && b.text?.trim()) {
    return role === "assistant"
      ? [{ text: b.text.trim(), kind: "text" }]
      : [{ text: `› ${clip(b.text, 3)}`, kind: "meta" }];
  }
  if (b.type === "tool_use") return [{ text: `● ${b.name}(${oneLine(toolSummary(b.input ?? {}))})`, kind: "tool" }];
  if (b.type === "tool_result") {
    const text =
      blocks(b.content)
        .map((c) => c.text ?? "")
        .join("\n")
        .trim() || "(no output)";
    return [{ text: `  ⎿ ${clip(text, 2).replaceAll("\n", "\n    ")}`, kind: b.is_error ? "error" : "result" }];
  }
  return [];
}

function toolSummary(input: Record<string, unknown>): string {
  for (const k of ["description", "command", "file_path", "pattern", "url", "query", "prompt"]) {
    if (typeof input[k] === "string") return input[k];
  }
  return JSON.stringify(input);
}

const blocks = (c: string | Block[] | undefined): Block[] =>
  typeof c === "string" ? [{ type: "text", text: c }] : (c ?? []);

const oneLine = (s: string, max = 120) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

/** The first `n` lines of `s`, with a count of the rest. */
function clip(s: string, n: number): string {
  const all = s.trim().split("\n");
  return all.slice(0, n).join("\n") + (all.length > n ? ` … (+${all.length - n} lines)` : "");
}

function runStats(r: LogRecord): string {
  const parts = [
    r.duration_ms != null && `${Math.round(r.duration_ms / 1000)}s`,
    r.total_cost_usd != null && `$${r.total_cost_usd.toFixed(2)}`,
  ];
  const s = parts.filter(Boolean).join(", ");
  return s ? `(${s}) ` : "";
}

/** Splits text into rows of at most `width` characters, at newlines and then at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  return text.split("\n").flatMap((line) => {
    const rows: string[] = [];
    while (line.length > w) {
      const space = line.lastIndexOf(" ", w);
      const cut = space > 0 ? space : w;
      rows.push(line.slice(0, cut));
      line = line.slice(space > 0 ? cut + 1 : cut);
    }
    return [...rows, line];
  });
}
