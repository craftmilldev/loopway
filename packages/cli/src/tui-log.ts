import { stateColors, theme } from "./tui-theme.js";

/** A piece of a row, drawn in one style. */
export interface Span {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/** One line of the log view: a gutter in the block's color, then what the line says. */
export interface LogRow {
  gutter: string;
  color: string;
  parts: Span[];
}

type Entry =
  | { type: "say"; text: string }
  | { type: "tool"; name: string; what: string }
  | { type: "sent" | "ask" | "you" | "error" | "note"; text: string };

interface Turn {
  number: number;
  /** How many updates were handed to the session at the start of this turn. */
  delivered: number | undefined;
  state: "running" | "finished" | "failed" | "stopped";
  /** `finished`, or what the run ended with. */
  ended: string | undefined;
  entries: Entry[];
}

type Item = { type: "turn"; turn: Turn } | { type: "loose"; entry: Entry } | { type: "divider"; text: string };

const TOOL = /^● (\S+?)\((.*)\)$/;

/**
 * The session log (what `transcribe` and the sessions wrote) as turns: each run is a block, its updates a detail of
 * it, its tool calls and messages the entries. What happens between runs (a chat starting, a message you typed) stands
 * alone.
 */
export function parseLog(log: string): Item[] {
  const items: Item[] = [];
  let turn: Turn | undefined;
  /** The turn that just closed: what the session logs right after a run ends (a failure, a silent turn) is about it. */
  let closed: Turn | undefined;
  let delivered: number | undefined;
  let turns = 0;
  const add = (entry: Entry) => {
    if (turn) turn.entries.push(entry);
    else items.push({ type: "loose", entry });
  };

  const lines = log.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const delivery = /^-> delivered (\d+) updates?$/.exec(line);
    if (delivery) {
      closed = undefined;
      delivered = Number(delivery[1]);
      continue;
    }
    if (line === "── run started ──") {
      if (turn?.state === "running") turn.state = "stopped";
      closed = undefined;
      turn = { number: ++turns, delivered, state: "running", ended: undefined, entries: [] };
      delivered = undefined;
      items.push({ type: "turn", turn });
      continue;
    }
    const run = /^── run (.+) ──$/.exec(line);
    if (run && turn) {
      turn.ended = run[1];
      turn.state = run[1] === "finished" ? "finished" : "failed";
      closed = turn;
      turn = undefined;
      continue;
    }
    const chat = /^── (chat .+) ──$/.exec(line);
    if (chat) {
      closed = undefined;
      items.push({ type: "divider", text: chat[1]! });
      continue;
    }
    if (line.startsWith("-> chat:")) continue;
    if (!turn && closed && line.startsWith("!! run failed")) {
      closed.entries.push({ type: "error", text: line.slice(3) });
      closed.state = "failed";
      closed.ended = "failed";
      closed = undefined;
      continue;
    }
    if (!turn && closed && line === "turn ended without a message") {
      closed.entries.push({ type: "note", text: line });
      continue;
    }
    if (line.startsWith("  ⎿ ")) continue; // what a tool returned: the call says enough
    const tool = TOOL.exec(line);
    if (tool) add({ type: "tool", name: tool[1]!, what: tool[2]! });
    else if (line.startsWith("<- ")) add({ type: "sent", text: line.slice(3) });
    else if (line.startsWith("?? ")) add({ type: "ask", text: line.slice(3) });
    else if (line.startsWith("you> ")) add({ type: "you", text: line.slice(5) });
    else if (line.startsWith("!! ")) {
      add({ type: "error", text: line.slice(3) });
      if (turn && line.startsWith("!! run failed")) {
        turn.state = "failed";
        turn.ended = "failed";
        turn = undefined;
      }
    } else if (/^(allowed|denied) /.test(line) || line === "turn ended without a message") {
      add({ type: "note", text: line });
    } else {
      const tail = items.at(-1);
      const last = turn ? turn.entries.at(-1) : tail?.type === "loose" ? tail.entry : undefined;
      if (last?.type === "say") last.text += "\n" + line;
      else add({ type: "say", text: line });
    }
  }
  return items;
}

const VERBS: Record<string, string> = {
  Bash: "Ran",
  Read: "Read",
  Edit: "Edited",
  MultiEdit: "Edited",
  Write: "Wrote",
  Grep: "Searched for",
  Glob: "Looked for files matching",
  WebFetch: "Fetched",
  WebSearch: "Searched the web for",
  Task: "Asked a helper:",
  Agent: "Asked a helper:",
  TodoWrite: "Updated its plan",
  comment: "Commented on",
  ask: "Asked on",
  create_issue: "Opened an issue in",
  create_pr: "Opened a pull request in",
};

/** A tool call as a sentence: `Ran: npm test`, `Commented on o/r#12`. */
export function explainTool(name: string, what: string): string {
  const short = name.replace(/^mcp__.+?__/, "");
  const verb = VERBS[short];
  if (!verb) return `Used ${short}${what ? `: ${what}` : ""}`;
  if (short === "TodoWrite") return verb;
  return what ? `${verb} ${what}` : verb;
}

const STATE_COLOR = {
  running: stateColors.running,
  finished: stateColors.idle,
  failed: stateColors.failed,
  stopped: theme.land,
};

/** The log as rows, each one line, so the view can scroll it a line at a time. */
export function logRows(log: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const item of parseLog(log)) {
    if (item.type === "divider") {
      rows.push({ gutter: "", color: theme.land, parts: [{ text: `· ${item.text} ·`, dim: true }] });
    } else if (item.type === "loose") {
      rows.push(...entryRows(item.entry, "", theme.land));
    } else {
      const { turn } = item;
      const color = STATE_COLOR[turn.state];
      const updates = !turn.delivered ? "" : ` · ${turn.delivered} update${turn.delivered === 1 ? "" : "s"}`;
      rows.push({
        gutter: "╭─ ",
        color,
        parts: [
          { text: `Turn ${turn.number}`, bold: true },
          { text: updates, dim: true },
          { text: ` · ${turn.state}`, color },
        ],
      });
      for (const entry of turn.entries) rows.push(...entryRows(entry, "│  ", color));
      if (turn.state !== "running") {
        rows.push({ gutter: "╰─ ", color, parts: [{ text: turn.ended ?? turn.state, color, dim: true }] });
      }
    }
  }
  return rows;
}

function entryRows(entry: Entry, gutter: string, color: string): LogRow[] {
  const row = (...parts: Span[]): LogRow => ({ gutter, color, parts });
  switch (entry.type) {
    case "say":
      return entry.text.split("\n").map((text) => row({ text }));
    case "tool":
      return [row({ text: "▸ ", color: theme.blue }, { text: explainTool(entry.name, entry.what), dim: true })];
    case "sent":
      return [row({ text: "✉ ", color: theme.green }, { text: entry.text, color: theme.green })];
    case "ask":
      return [row({ text: "? ", color: theme.land }, { text: entry.text, color: theme.land })];
    case "you":
      return [row({ text: "you ", color: theme.red, bold: true }, { text: entry.text })];
    case "error":
      return [row({ text: "✗ ", color: theme.red }, { text: entry.text, color: theme.red })];
    case "note":
      return [row({ text: `· ${entry.text}`, dim: true })];
  }
}
