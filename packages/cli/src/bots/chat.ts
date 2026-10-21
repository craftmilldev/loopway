import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getHarness, type AgentRun, type RunOutcome } from "@loopway/harnesses";
import { MANAGER_ALLOWED_TOOLS, MANAGER_DENIED_TOOLS, MANAGER_PROMPT } from "@loopway/presets";
import { chatLogPath, type TranscriptLine } from "./transcript.js";

/** Who a chat message is from. */
export type ChatSpeaker = "you" | "manager";

export interface ChatMessage {
  from: ChatSpeaker;
  text: string;
  /** How the manager's line was shown in its session: its words, a tool it ran, or an error. */
  kind?: "text" | "tool" | "error";
}

/** The chat as the view shows it: the transcript, oldest first, and whether a run is still in flight. */
export interface Chat {
  messages: ChatMessage[];
  thinking: boolean;
}

/** What the Chat view talks to. No ink in this file or behind it, so a web UI can reuse it. */
export interface ChatBackend {
  /** Starts a turn. `empty` and `busy` (a run is in flight) start nothing; `done` settles when the run is over, and never rejects. */
  send(text: string): { result: "sent" | "empty" | "busy"; done: Promise<void> };
  read(): Promise<Chat>;
}

export const emptyChat = (): Chat => ({ messages: [], thinking: false });

/** An unreachable MCP endpoint: the manager has no thread, and its tools come from `allowedTools`, not the dispatcher. */
const NO_MCP_URL = "http://127.0.0.1:1/mcp/manager";

export interface ManagerChatOptions {
  /** The org's slug; the manager's bot id is derived from it. */
  org: string;
  /** ~/.loopway: where the chat's transcript log goes. */
  dir: string;
  env: NodeJS.ProcessEnv;
  /** From `manager.harness` and `manager.model`. */
  harness: string;
  model?: string;
  runAgent: (run: AgentRun) => Promise<RunOutcome>;
  /** Records a product metric. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
}

interface Turn {
  text: string;
  /** Where this turn's output starts in the log (once the run is about to start), and where it ends once it is over. */
  from?: number;
  to?: number;
  /** Why the run failed, if it did. */
  error?: string;
}

/**
 * The org's manager bot. It has no row in the bots database: its id is `manager:<org>`, and each chat is one agent
 * session on the configured harness. The first message starts the session (with the manager prompt in front), later
 * ones resume it. The session's output is appended to `~/.loopway/chats/<chat>.log`, and the transcript is read back
 * from there, as a thread's is.
 */
export class ManagerChat implements ChatBackend {
  readonly botId: string;
  private readonly chatId = randomUUID();
  private readonly logPath: string;
  private sessionId = this.chatId;
  private started = false;
  private turns: Turn[] = [];
  private running = false;

  constructor(private readonly opts: ManagerChatOptions) {
    this.botId = `manager:${opts.org}`;
    this.logPath = chatLogPath(opts.dir, this.chatId);
  }

  send(text: string): { result: "sent" | "empty" | "busy"; done: Promise<void> } {
    const trimmed = text.trim();
    if (!trimmed) return { result: "empty", done: Promise.resolve() };
    if (this.running) return { result: "busy", done: Promise.resolve() };
    this.running = true;
    const turn: Turn = { text: trimmed };
    this.turns.push(turn);
    return { result: "sent", done: this.turn(turn) };
  }

  async read(): Promise<Chat> {
    const log = await this.readLog();
    const messages = this.turns.flatMap((t): ChatMessage[] => {
      const lines = t.from === undefined ? [] : getHarness(this.opts.harness).transcript(log.slice(t.from, t.to));
      return [
        { from: "you", text: t.text },
        ...lines.flatMap(managerLine),
        ...(t.error ? [{ from: "manager" as const, text: t.error, kind: "error" as const }] : []),
      ];
    });
    return { messages, thinking: this.running };
  }

  private readLog = () => readFile(this.logPath, "utf8").catch(() => "");

  private async turn(turn: Turn): Promise<void> {
    const { text } = turn;
    turn.from = (await this.readLog()).length;
    const harness = this.opts.harness;
    try {
      const outcome = await this.opts.runAgent({
        harness,
        sessionId: this.sessionId,
        resume: this.started,
        message: this.started ? text : `${MANAGER_PROMPT}\n\n${text}`,
        model: this.opts.model ?? "",
        logPath: this.logPath,
        mcpUrl: NO_MCP_URL,
        env: this.opts.env,
        allowedTools: MANAGER_ALLOWED_TOOLS,
        deniedTools: MANAGER_DENIED_TOOLS,
        onStarted: () => void (this.started = true),
      });
      const failure = failureOf(outcome);
      if (failure) this.fail(turn, failure.reason, failure.text);
      else this.opts.capture?.("manager_reply_finished", { harness });
    } catch (err) {
      this.fail(turn, "start_failed", `The manager couldn't run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      turn.to = (await this.readLog()).length;
      this.running = false;
    }
  }

  private fail(turn: Turn, reason: string, text: string) {
    turn.error = text;
    // A session that never got going can't be resumed, and its id may be taken: the next message starts a new one.
    if (!this.started) this.sessionId = randomUUID();
    this.opts.capture?.("manager_run_failed", { harness: this.opts.harness, reason });
  }
}

/** Why a finished run counts as a failure, if it does. */
function failureOf(o: RunOutcome): { reason: string; text: string } | undefined {
  if (o.limitedUntil) return { reason: "usage_limit", text: "The manager hit the usage limit; try again later." };
  if (o.apiError) return { reason: "api_error", text: `The manager's run failed: ${o.apiError}` };
  if (o.code !== 0) return { reason: "exit_code", text: `The manager's run failed (exit code ${o.code}).` };
  return undefined;
}

/** What the chat shows of one line of the session's transcript: its words, the tools it ran and errors, but not results or run markers. */
function managerLine(l: TranscriptLine): ChatMessage[] {
  return l.kind === "text" || l.kind === "tool" || l.kind === "error"
    ? [{ from: "manager", text: l.text, kind: l.kind }]
    : [];
}
