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
  /** Claude's turn (an object), or Codex's `error` text. */
  message?: { content?: string | Block[] } | string;
  duration_ms?: number;
  total_cost_usd?: number;
  /** Hermes' `result`: the run's exit code and, when it failed, why. */
  exit_code?: number;
  error?: unknown;
  item?: CodexItem;
  /** Cursor's tool call: one key (`shellToolCall`, `readToolCall`, ...) holding its args. */
  tool_call?: Record<string, { args?: Record<string, unknown> }>;
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number | null;
  server?: string;
  tool?: string;
  error?: unknown;
}

/**
 * Turns a session log (the stream-json of Claude Code, Cursor and Hermes, Codex's JSONL, plus anything it wrote to stderr) into readable
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
    else if (r.type === "result") lines.push({ text: runResult(r), kind: "meta" });
    else if (r.type === "thread.started") lines.push({ text: "── run started ──", kind: "meta" });
    else if (r.type === "turn.completed") lines.push({ text: "── run finished ──", kind: "meta" });
    else if (r.type === "turn.failed") lines.push({ text: `── run failed: ${errorMessage(r.error)} ──`, kind: "meta" });
    else if (r.type === "error") lines.push({ text: errorMessage(r.message), kind: "error" });
    else if (r.type === "item.completed" && r.item) lines.push(...codexItemLines(r.item));
    else if (r.type === "tool_call" && r.subtype === "started") lines.push(...cursorToolLines(r.tool_call));
    else if (r.type === "assistant" || r.type === "user") {
      for (const b of blocks(typeof r.message === "object" ? r.message.content : undefined))
        lines.push(...blockLines(r.type, b));
    }
  }
  return lines;
}

/** The end of a run: Claude's and Cursor's `result` carry a subtype, Hermes' an exit code. */
function runResult(r: LogRecord): string {
  const failed = r.subtype ? r.subtype !== "success" : Boolean(r.exit_code) || Boolean(r.error);
  const why = typeof r.error === "string" && r.error ? `: ${oneLine(r.error)}` : "";
  const how = r.subtype && r.subtype !== "success" ? r.subtype : "failed";
  return `── run ${failed ? how : "finished"}${why} ${runStats(r)}──`;
}

function errorMessage(e: unknown): string {
  const m = typeof e === "string" ? e : (e as { message?: unknown } | undefined)?.message;
  return typeof m === "string" && m ? oneLine(m) : "the run ended in an error";
}

/** What Codex finished: the agent's messages, each command with its exit code, each MCP call. */
function codexItemLines(item: CodexItem): TranscriptLine[] {
  if (item.type === "agent_message" && item.text?.trim()) return [{ text: item.text.trim(), kind: "text" }];
  if (item.type === "command_execution") {
    const failed = item.exit_code != null && item.exit_code !== 0;
    return [
      { text: `● ${oneLine(item.command ?? "")}`, kind: "tool" },
      { text: `  ⎿ exit ${item.exit_code ?? "?"}`, kind: failed ? "error" : "result" },
    ];
  }
  if (item.type === "mcp_tool_call") {
    const failed = Boolean(item.error);
    return [
      { text: `● ${item.server}.${item.tool}()`, kind: "tool" },
      ...(failed ? [{ text: `  ⎿ ${errorMessage(item.error)}`, kind: "error" as const }] : []),
    ];
  }
  return [];
}

/** One line per Cursor tool call, when it starts (its `completed` record repeats it with the result). */
function cursorToolLines(call: LogRecord["tool_call"]): TranscriptLine[] {
  const [key, value] = Object.entries(call ?? {})[0] ?? [];
  if (!key) return [];
  const args = value?.args ?? {};
  const name = key.replace(/ToolCall$/, "");
  for (const k of ["command", "path", "pattern", "name", "server"]) {
    if (typeof args[k] === "string" && args[k]) return [{ text: `● ${name}(${oneLine(args[k])})`, kind: "tool" }];
  }
  return [{ text: `● ${name}()`, kind: "tool" }];
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
