import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRun, RunWatch } from "./agent.js";
import { Harness, type Launch } from "./harness.js";
import { HARNESS_LABELS } from "./labels.js";
import { errorMessage, runStats, streamJsonLines, transcribe } from "./transcript.js";

/**
 * Reads the JSONL `hermes chat --format stream-json` prints: a `system` `init` record first, then `text` and tool
 * records, then one `result` record that carries `exit_code` and, when the run failed, `error`. Hermes has no
 * usage-limit signal and doesn't echo the prompt, so the message counts as delivered once the session has started.
 */
export class HermesWatch implements RunWatch {
  delivered = false;
  finished = false;
  private error?: string;

  constructor(private readonly onInit?: () => void) {}

  line(raw: string): void {
    let r: { type?: string; subtype?: string; exit_code?: number; error?: unknown };
    try {
      r = JSON.parse(raw) as typeof r;
    } catch {
      return;
    }
    if (r.type === "system" && r.subtype === "init") {
      this.delivered = true;
      this.onInit?.();
    } else if (r.type === "result") {
      this.finished = true;
      if (typeof r.error === "string" && r.error) this.error = r.error;
      else if (r.exit_code) this.error = `the run ended with exit code ${r.exit_code}`;
    }
  }

  apiError(): string | undefined {
    return this.error;
  }

  limitedUntil(): undefined {
    return undefined;
  }
}

/** `text` with the top-level `key:` block removed (the line and everything under it, up to the next top-level line). */
export function withoutTopLevelKey(text: string, key: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    // A block sequence may sit at the key's own indent, so `- ` lines belong to the block too.
    if (/^\S/.test(line) && !line.startsWith("-")) skipping = line.startsWith(`${key}:`);
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/**
 * Nous Research's Hermes Agent, run as `hermes chat --query-file -`. Hermes reads its MCP servers, credentials and
 * sessions from its home (`~/.hermes`), and each loopway session has its own MCP endpoint, so every session gets a
 * home of its own beside its log: the user's `config.yaml` (minus their MCP servers) and links to their credentials, plus the loopway
 * server. Its `state.db` lives there too, so a resumed run continues the session with `--resume latest`.
 */
export class HermesHarness extends Harness {
  readonly name = "hermes";
  readonly label = HARNESS_LABELS.hermes;
  readonly command = "hermes";

  /** Hermes' models depend on its provider and the account, so any name goes through and `hermes` has the last word. */
  modelFits(model: string) {
    return model.trim().length > 0;
  }

  private home = (run: AgentRun) => `${run.logPath}.home`;

  async before(run: AgentRun): Promise<void> {
    const home = this.home(run);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const userHome = run.env.HERMES_HOME || join(homedir(), ".hermes");
    const config = await readFile(join(userHome, "config.yaml"), "utf8").catch(() => "");
    const rest = withoutTopLevelKey(config, "mcp_servers").trimEnd();
    const loopway = `mcp_servers:\n  loopway:\n    url: ${JSON.stringify(run.mcpUrl)}\n`;
    await writeFile(join(home, "config.yaml"), (rest ? rest + "\n\n" : "") + loopway, { mode: 0o600 });
    // The credentials: API keys in `.env`, and the tokens an OAuth login leaves in `auth.json`. They are linked, not
    // copied, so a token Hermes refreshes in one session is the one every session (and the user) sees, rather than
    // each session keeping a copy that goes stale.
    for (const file of [".env", "auth.json"]) {
      if (!existsSync(join(userHome, file))) continue;
      await rm(join(home, file), { force: true });
      await symlink(join(userHome, file), join(home, file));
    }
  }

  async launch(run: AgentRun): Promise<Launch> {
    // A resumed session whose home is gone (the log directory was cleaned, or another runner made it) starts a new
    // session; the message still goes in, but without the old conversation.
    const resume = run.resume && existsSync(join(this.home(run), "state.db"));
    const args = [
      "chat",
      "--query-file",
      "-",
      "--format",
      "stream-json",
      "--yolo",
      ...(run.model ? ["--model", run.model] : []),
    ];
    if (resume) args.push("--resume", "latest");
    return { args, stdin: run.message, env: { HERMES_HOME: this.home(run) } };
  }

  /** Claude's stream-json, except that the `result` has an exit code and an error instead of a subtype. */
  transcript(log: string) {
    return transcribe(log, (r) => {
      if (r.type !== "result") return streamJsonLines(r);
      const failed = Boolean(r.exit_code) || Boolean(r.error);
      const text = failed ? `failed: ${errorMessage(r.error ?? `exit code ${r.exit_code}`)}` : "finished";
      return [{ text: `── run ${text} ${runStats(r)}──`, kind: "meta" }];
    });
  }

  watch(onStarted?: () => void) {
    return new HermesWatch(onStarted);
  }
}
