import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getHarness, type AgentRun, type RunOutcome } from "@loopway/harnesses";
import { MANAGER_ALLOWED_TOOLS, MANAGER_DENIED_TOOLS, MANAGER_PROMPT } from "@loopway/presets";
import {
  approvalKey,
  changeBlocks,
  parseProposal,
  proposalBlock,
  runLoopway,
  type ChangeKind,
  type CommandResult,
  type ParseFailure,
  type Proposal,
} from "./chat-changes.js";
import { chatChangesPath, chatLogPath, type TranscriptLine } from "./transcript.js";

/** Who a chat message is from. */
export type ChatSpeaker = "you" | "manager";

export interface ChatMessage {
  from: ChatSpeaker;
  text: string;
  /** How the manager's line was shown in its session: its words, a tool it ran, or an error. */
  kind?: "text" | "tool" | "error" | "result";
}

/** The chat as the view shows it: the transcript, oldest first, whether a run is still in flight, and a change awaiting an answer. */
export interface Chat {
  messages: ChatMessage[];
  thinking: boolean;
  /** A change the manager proposed, which runs only if the user approves it. */
  pending?: Proposal;
}

/** What the Chat view talks to. No ink in this file or behind it, so a web UI can reuse it. */
export interface ChatBackend {
  /** Starts a turn. `empty` and `busy` (a run is in flight) start nothing; `done` settles when the run is over, and never rejects. */
  send(text: string): { result: "sent" | "empty" | "busy"; done: Promise<void> };
  /** Answers the pending proposal: approving runs that exact command, denying runs nothing. `none` means there is nothing to answer. */
  answer(approved: boolean): { result: "answered" | "none"; done: Promise<void> };
  read(): Promise<Chat>;
}

export const emptyChat = (): Chat => ({ messages: [], thinking: false });

/** One change the session made, as written to `~/.loopway/chats/<chat>.changes.jsonl`, a line each. */
export interface ChangeRecord {
  kind: ChangeKind;
  target: "bot" | "inbox";
  name?: string;
  /** False when the approved command failed. */
  ok: boolean;
  at: string;
}

/** Why a change command didn't run, or didn't succeed. */
export type ChangeOutcome =
  { ok: true; output: string } | { ok: false; reason: ParseFailure | "not_approved" | "failed"; output: string };

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
  /** Runs an approved `loopway` command (the words after `loopway`); the real CLI by default. */
  runCommand?: (args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;
  /** Records a product metric. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
}

interface Turn {
  text: string;
  /** Where this turn's output starts in the log (once the run is about to start), and where it ends once it is over. */
  from?: number;
  to?: number;
  /** A warning shown before the reply. */
  notice?: string;
  /** Why the run failed, if it did. */
  error?: string;
  /** Shown instead of the user's words when the turn is the chat reporting back on a change; `text` then goes only to the manager. */
  report?: ChatMessage[];
  /** Notes shown after the reply, such as a proposal that was refused. */
  after?: ChatMessage[];
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
  private pending?: Proposal;
  /** What the manager is told before the user's next message: a refused proposal, an ignored second one. */
  private notes: string[] = [];
  /** Proposals the user approved and that haven't run yet, keyed by `approvalKey`. A key works once. */
  private approvals = new Set<string>();

  constructor(private readonly opts: ManagerChatOptions) {
    this.botId = `manager:${opts.org}`;
    this.logPath = chatLogPath(opts.dir, this.chatId);
  }

  send(text: string): { result: "sent" | "empty" | "busy"; done: Promise<void> } {
    const trimmed = text.trim();
    if (!trimmed) return { result: "empty", done: Promise.resolve() };
    // A proposal waiting for an answer holds the chat too: the user answers it first.
    if (this.running || this.pending) return { result: "busy", done: Promise.resolve() };
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
        ...(t.report ?? [{ from: "you" as const, text: t.text }]),
        ...(t.notice ? [{ from: "manager" as const, text: t.notice, kind: "error" as const }] : []),
        ...lines.flatMap(managerLine),
        ...(t.error ? [{ from: "manager" as const, text: t.error, kind: "error" as const }] : []),
        ...(t.after ?? []),
      ];
    });
    return { messages, thinking: this.running, ...(this.pending && !this.running ? { pending: this.pending } : {}) };
  }

  answer(approved: boolean): { result: "answered" | "none"; done: Promise<void> } {
    const proposal = this.pending;
    if (!proposal || this.running) return { result: "none", done: Promise.resolve() };
    this.pending = undefined;
    this.running = true;
    return { result: "answered", done: this.settle(proposal, approved) };
  }

  /**
   * Runs a change command, but only one the user has approved in this chat: the same command and file text the view
   * showed, once. This is the one door to the CLI for changes; the session itself is denied them.
   */
  async execute(proposal: Proposal): Promise<ChangeOutcome> {
    // Re-read from the command line, so a proposal built by hand can't carry more than its text says.
    const parsed = parseProposal(proposalBlock(proposal));
    if (!parsed.ok) return { ok: false, reason: parsed.reason, output: parsed.text };
    const key = approvalKey(parsed.proposal);
    if (!this.approvals.delete(key))
      return {
        ok: false,
        reason: "not_approved",
        output: "That command wasn't approved in this chat, so it didn't run.",
      };

    const dir = await mkdtemp(join(tmpdir(), "loopway-change-"));
    try {
      let args = parsed.proposal.args;
      for (const [placeholder, text] of Object.entries(parsed.proposal.files)) {
        const path = join(dir, placeholder.slice(1));
        await writeFile(path, text);
        args = args.map((a) =>
          a === placeholder ? path : a.endsWith(`=${placeholder}`) ? a.replace(placeholder, path) : a,
        );
      }
      const { code, output } = await (this.opts.runCommand ?? runLoopway)(args, this.opts.env);
      return code === 0 ? { ok: true, output } : { ok: false, reason: "failed", output };
    } catch (err) {
      return { ok: false, reason: "failed", output: err instanceof Error ? err.message : String(err) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Acts on the user's answer, then tells the manager what happened so it can say so. */
  private async settle(proposal: Proposal, approved: boolean): Promise<void> {
    const { kind, target } = proposal;
    let report: ChatMessage;
    let tell: string;
    if (!approved) {
      this.opts.capture?.("manager_change_denied", { kind, target });
      report = { from: "you", text: `denied: ${proposal.command}`, kind: "result" };
      tell = `The user denied the proposed command, so nothing ran and nothing changed: ${proposal.command}`;
    } else {
      this.approvals.add(approvalKey(proposal));
      const outcome = await this.execute(proposal);
      const shown = clip(outcome.output) || "(no output)";
      if (outcome.ok) {
        this.opts.capture?.("manager_change_done", { kind, target });
        await this.record({ kind, target, name: proposal.name, ok: true, at: new Date().toISOString() });
        report = { from: "manager", text: `ran: ${proposal.command}\n${shown}`, kind: "result" };
        tell = `The user approved it and it ran: ${proposal.command}\nOutput:\n${shown}\nTell the user how it went.`;
      } else {
        this.opts.capture?.("manager_change_failed", { kind, target, reason: outcome.reason });
        // An approved command that failed changed nothing the log should count.
        await this.record({ kind, target, name: proposal.name, ok: false, at: new Date().toISOString() });
        report = { from: "manager", text: `failed: ${proposal.command}\n${shown}`, kind: "error" };
        tell = `The user approved it but it failed: ${proposal.command}\nOutput:\n${shown}\nTell the user what went wrong.`;
      }
    }
    const turn: Turn = { text: tell, report: [report] };
    this.turns.push(turn);
    await this.turn(turn);
  }

  /** Appends one structured line per approved change to the chat's `.changes.jsonl`, for what labels sessions next. */
  private async record(change: ChangeRecord): Promise<void> {
    const path = chatChangesPath(this.opts.dir, this.chatId);
    // A log that can't be written must not undo or hide a change that already happened.
    await mkdir(dirname(path), { recursive: true })
      .then(() => appendFile(path, JSON.stringify(change) + "\n"))
      .catch(() => {});
  }

  private readLog = () => readFile(this.logPath, "utf8").catch(() => "");

  private async turn(turn: Turn): Promise<void> {
    const text = [...this.notes.splice(0), turn.text].join("\n\n");
    turn.from = (await this.readLog()).length;
    // Only Claude Code holds the manager to its tool list; say so, once, where the user is looking.
    if (!this.started && !getHarness(this.opts.harness).enforcesTools) {
      turn.notice = `${getHarness(this.opts.harness).label} can't enforce the manager's tool list, so only its prompt keeps it from running change commands itself; your approval is only guaranteed for the changes it proposes. Use the claude harness to enforce it.`;
      this.opts.capture?.("manager_unenforced_harness", { harness: this.opts.harness });
    }
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
      const log = await this.readLog();
      turn.to = log.length;
      this.propose(turn, log);
      this.running = false;
    }
  }

  /** Takes the change the manager proposed in this turn, if any, as the one waiting for the user's answer. */
  private propose(turn: Turn, log: string) {
    if (turn.from === undefined || turn.error) return;
    const texts = managerTexts(getHarness(this.opts.harness).transcript(log.slice(turn.from, turn.to)));
    const blocks = texts.flatMap(changeBlocks);
    if (!blocks.length) return;
    const parsed = parseProposal(blocks[0]!);
    if (!parsed.ok) {
      this.opts.capture?.("manager_change_refused", { reason: parsed.reason });
      turn.after = [{ from: "manager", text: `Refused: ${parsed.text}`, kind: "error" }];
      // The manager hears why on the user's next message.
      this.notes.push(`Your last proposal was refused and nothing ran: ${parsed.text}`);
      return;
    }
    this.pending = parsed.proposal;
    this.opts.capture?.("manager_change_proposed", { kind: parsed.proposal.kind, target: parsed.proposal.target });
    if (blocks.length > 1)
      this.notes.push("Only your first proposal was shown to the user; propose the others one at a time.");
  }

  private fail(turn: Turn, reason: string, text: string) {
    turn.error = text;
    // A session that never got going can't be resumed, and its id may be taken: the next message starts a new one.
    if (!this.started) this.sessionId = randomUUID();
    this.opts.capture?.("manager_run_failed", { harness: this.opts.harness, reason });
  }
}

/** What the manager said in a turn, in order: the words of its replies, without the tools it ran. */
function managerTexts(lines: TranscriptLine[]): string[] {
  return lines.filter((l) => l.kind === "text").map((l) => l.text);
}

/** Clips a command's output for the chat and for the manager. */
function clip(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
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
