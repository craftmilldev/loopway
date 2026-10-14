import { LimitWatch, type AgentRun } from "../agent.js";
import { Harness, type Launch } from "../harness.js";

/** Claude Code, run as `claude -p`. */
export class ClaudeHarness extends Harness {
  readonly name = "claude";
  readonly command = "claude";

  launch(run: AgentRun): Launch {
    const mcpConfig = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
    const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
    // --mcp-config and --allowedTools take several values, so each is followed by another flag.
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link", "mcp__loopway__end");
    // Resumed runs get it too: a session keeps its model only if the flag says so.
    args.push("--model", run.model, "--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
    // The message goes in as stream-json so Claude Code can echo it back once it's in the session.
    args.push("--input-format", "stream-json", "--replay-user-messages");
    return { args, stdin: JSON.stringify({ type: "user", message: { role: "user", content: run.message } }) + "\n" };
  }

  watch(onStarted?: () => void) {
    return new LimitWatch(onStarted);
  }
}
