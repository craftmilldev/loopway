interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | Block[];
  is_error?: boolean;
}

interface Record_ {
  type?: string;
  subtype?: string;
  /** Set on a subagent's messages; only the session's own turns are shown. */
  parent_tool_use_id?: string | null;
  message?: { content?: string | Block[] };
  duration_ms?: number;
}

/**
 * One line of Claude Code's stream-json as lines of the session log: assistant text, each tool call on one line,
 * the start of each tool result, and a line for the run starting and ending. Records it doesn't know give none, and
 * a line that isn't JSON (what the process wrote that wasn't a record) is shown as it is.
 */
export function transcribe(raw: string): string[] {
  let r: Record_;
  try {
    r = JSON.parse(raw) as Record_;
  } catch {
    return raw.trim() ? [raw] : [];
  }
  if (r.parent_tool_use_id) return [];
  if (r.type === "system" && r.subtype === "init") return ["── run started ──"];
  if (r.type === "result") return [`── run ${r.subtype === "success" ? "finished" : (r.subtype ?? "failed")} ──`];
  if (r.type !== "assistant" && r.type !== "user") return [];
  return blocks(r.message?.content).flatMap((b) => lines(r.type!, b));
}

function lines(role: string, b: Block): string[] {
  if (b.type === "text" && b.text?.trim()) return role === "assistant" ? [b.text.trim()] : [];
  if (b.type === "tool_use") return [`● ${b.name}(${oneLine(summary(b.input ?? {}))})`];
  if (b.type === "tool_result") {
    const text = blocks(b.content)
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    return [`  ⎿ ${oneLine(text || "(no output)")}`];
  }
  return [];
}

function summary(input: Record<string, unknown>): string {
  for (const k of ["description", "command", "file_path", "pattern", "url", "query", "prompt", "subject"]) {
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
