/** One line of a session transcript as the TUI shows it. */
export interface TranscriptLine {
  text: string;
  kind: "text" | "tool" | "result" | "error" | "meta";
}

/** Turns one parsed record of a harness's output into lines; the ones it doesn't know give none. */
export type RecordLines = (record: StreamRecord) => TranscriptLine[];

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | Block[];
  is_error?: boolean;
}

/** The fields of the records the harnesses print that the transcript reads; each harness uses its own few. */
export interface StreamRecord {
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
  /** Codex: an item of a turn (a message, a command). */
  item?: {
    type?: string;
    text?: string;
    command?: string;
    exit_code?: number | null;
    server?: string;
    tool?: string;
    error?: unknown;
  };
  /** Cursor's tool call: one key (`shellToolCall`, `readToolCall`, ...) holding its args. */
  tool_call?: Record<string, { args?: Record<string, unknown> }>;
}

/**
 * Reads a session log record by record: `lines` says what each JSON record shows, and anything that isn't JSON
 * (what the harness wrote to stderr) is shown as an error.
 */
export function transcribe(log: string, lines: RecordLines): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of log.split("\n")) {
    if (!raw.trim()) continue;
    let r: StreamRecord;
    try {
      r = JSON.parse(raw) as StreamRecord;
    } catch {
      out.push({ text: raw, kind: "error" });
      continue;
    }
    out.push(...lines(r));
  }
  return out;
}

/**
 * The records Claude Code's stream-json has, which Cursor and Hermes print too: `system` `init`, assistant text and
 * tool calls, the start of each tool result, and a `result` per run.
 */
export function streamJsonLines(r: StreamRecord): TranscriptLine[] {
  if (r.parent_tool_use_id) return [];
  if (r.type === "system" && r.subtype === "init") return [{ text: "── run started ──", kind: "meta" }];
  if (r.type === "result") {
    const how = r.subtype === "success" ? "finished" : (r.subtype ?? "failed");
    return [{ text: `── run ${how} ${runStats(r)}──`, kind: "meta" }];
  }
  if (r.type !== "assistant" && r.type !== "user") return [];
  const role = r.type;
  return blocks(typeof r.message === "object" ? r.message.content : undefined).flatMap((b) => blockLines(role, b));
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

export const oneLine = (s: string, max = 120) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

/** The first `n` lines of `s`, with a count of the rest. */
function clip(s: string, n: number): string {
  const all = s.trim().split("\n");
  return all.slice(0, n).join("\n") + (all.length > n ? ` … (+${all.length - n} lines)` : "");
}

export function runStats(r: StreamRecord): string {
  const parts = [
    r.duration_ms != null && `${Math.round(r.duration_ms / 1000)}s`,
    r.total_cost_usd != null && `$${r.total_cost_usd.toFixed(2)}`,
  ];
  const s = parts.filter(Boolean).join(", ");
  return s ? `(${s}) ` : "";
}

/** The text of an error that is a string or has a `message`. */
export function errorMessage(e: unknown): string {
  const m = typeof e === "string" ? e : (e as { message?: unknown } | undefined)?.message;
  return typeof m === "string" && m ? oneLine(m) : "the run ended in an error";
}
