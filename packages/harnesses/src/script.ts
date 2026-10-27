import type { AgentRun, RunOutcome, RunWatch } from "./agent.js";
import { Harness, type Launch } from "./harness.js";
import { HARNESS_LABELS } from "./labels.js";
import type { TranscriptLine } from "./transcript.js";

/** Exit code a script uses to say "not done, wake me on the next message" (-1, as a shell sees it). */
export const SCRIPT_WAITING = 255;

/** A script has no session protocol: it has the message once it is spawned, and its exit says how it went. */
export class ScriptWatch implements RunWatch {
  delivered = true;
  finished = true;

  constructor(onInit?: () => void) {
    onInit?.();
  }

  line(raw: string): void {
    void raw;
  }

  apiError(): undefined {
    return undefined;
  }

  limitedUntil(): undefined {
    return undefined;
  }
}

/**
 * A shell command instead of a coding agent, for bots that call an API and act on the answer themselves. The command
 * is the bot's prompt (so it is versioned and pushed like one), runs in the bot's directory with the messages on
 * stdin, and gets LOOPWAY_SESSION_ID and LOOPWAY_MCP_URL in its environment. Exit 0 ends the thread, 255 (-1) leaves
 * it waiting for its next messages, and anything else is a failed run.
 */
export class ScriptHarness extends Harness {
  readonly name = "script";
  readonly label = HARNESS_LABELS.script;
  readonly command = "sh";

  /** There is no model to pick: the bot's `model` is not read, so any non-empty value fits. */
  modelFits(model: string) {
    return model.length > 0;
  }

  launch(run: AgentRun): Launch {
    if (!run.script)
      throw new Error(
        "This bot runs scripts, but its prompt (the command) is empty; save one with `loopway bots edit --prompt-file`.",
      );
    return {
      args: ["-c", run.script],
      stdin: run.message,
      env: { LOOPWAY_SESSION_ID: run.sessionId, LOOPWAY_MCP_URL: run.mcpUrl },
    };
  }

  /** A script prints plain text, so every line is shown as it is. */
  transcript(log: string): TranscriptLine[] {
    return log
      .split("\n")
      .filter((l) => l.trim())
      .map((text) => ({ text, kind: "text" }));
  }

  /** A script's output has no end marker, so a log is never known to be finished. */
  runFinished(): boolean {
    return false;
  }

  watch(onStarted?: () => void) {
    return new ScriptWatch(onStarted);
  }

  async run(run: AgentRun): Promise<RunOutcome> {
    const outcome = await super.run(run);
    if (outcome.code === SCRIPT_WAITING) return { ...outcome, code: 0, ended: false };
    return { ...outcome, ended: outcome.code === 0 };
  }
}
