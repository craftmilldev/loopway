import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRun } from "./agent.js";
import { LimitWatch } from "./claude-watch.js";
import { Harness, type CanRun, type Launch } from "./harness.js";
import { openProxyPort } from "./open-proxy.js";
import { expandPath, sandboxPolicy, sharedGitDir, type SandboxPolicy } from "./sandbox.js";

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The hook that guards the file tools' writes, which the sandbox doesn't cover. It sits next to this file, in src and in dist. */
const WRITE_GUARD = fileURLToPath(new URL("./write-guard.mjs", import.meta.url));

/** The `--settings` value that puts a Claude Code run in its sandbox, with the network left open. */
export function claudeSandboxSettings(cwd: string, proxyPort: number, policy: SandboxPolicy = sandboxPolicy()) {
  // Better to refuse to start a run than to run with the file tools unguarded (a build that skipped the copy, say).
  if (!existsSync(WRITE_GUARD)) throw new Error(`The write guard is missing: ${WRITE_GUARD}`);
  const gitDir = sharedGitDir(cwd);
  const allowWrite = gitDir ? [...policy.allowWrite, gitDir] : policy.allowWrite;
  // The file tools follow permission rules rather than the sandbox; there `~/` is the home directory too.
  const denyTools = policy.denyRead.flatMap((p) => [`Read(${p}/**)`, `Read(${p})`, `Edit(${p}/**)`, `Edit(${p})`]);
  const guard = JSON.stringify({ roots: [cwd, ...allowWrite].map(expandPath), deny: policy.denyWrite.map(expandPath) });
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit",
          hooks: [
            {
              type: "command",
              // Claude Code only blocks on exit 2, so a guard that can't even start (node's own exit 1) must still deny.
              command: `LOOPWAY_WRITE_GUARD=${shq(guard)} ${shq(process.execPath)} ${shq(WRITE_GUARD)} || exit 2`,
            },
          ],
        },
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // A command that fails in the sandbox must not be retried outside it.
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite, denyWrite: policy.denyWrite, denyRead: policy.denyRead },
      // No domain restrictions. Claude's own proxy rejects a bare `*` in allowedDomains and denies any other host a
      // headless run can't be asked about, so commands go through our proxy, which lets every host through.
      network: { httpProxyPort: proxyPort },
    },
    permissions: { allow: ["WebFetch(domain:*)"], deny: denyTools },
  };
}

/** Why Claude's sandbox can't run on this platform, with what to do about it; ok if it can. */
export function claudeCanRun(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? "",
): CanRun {
  if (platform === "darwin") return { ok: true };
  if (platform === "win32")
    return {
      ok: false,
      reason: "unsupported_platform",
      message: "Claude bots run in a sandbox, which native Windows doesn't support. Run loopway inside WSL2 instead.",
    };
  if (platform !== "linux")
    return {
      ok: false,
      reason: "unsupported_platform",
      message: `Claude bots run in a sandbox, which isn't supported on ${platform}. Use macOS, Linux or WSL2.`,
    };
  const onPath = (bin: string) =>
    pathEnv.split(delimiter).some((d) => {
      try {
        accessSync(join(resolve(d), bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const missing = [
    ["bwrap", "bubblewrap"],
    ["socat", "socat"],
  ]
    .filter(([bin]) => !onPath(bin!))
    .map(([, pkg]) => pkg!);
  if (!missing.length) return { ok: true };
  const pkgs = missing.join(" ");
  return {
    ok: false,
    reason: "missing_dependency",
    message: `Claude bots run in a sandbox, which needs ${pkgs}. Install with \`sudo apt-get install ${pkgs}\` (or \`sudo dnf install ${pkgs}\`).`,
  };
}

/** Claude Code, run as `claude -p`. */
export class ClaudeHarness extends Harness {
  readonly name = "claude";
  readonly command = "claude";

  /** Aliases for the latest of a family, and full ids to pin a version. Add new models here and drop deprecated ones. */
  readonly models = [
    "best",
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ];

  modelFits(model: string) {
    return this.models.includes(model);
  }

  /** Claude runs in its sandbox unless the user opts out, so it can't run where the sandbox can't. */
  canRun(): CanRun {
    return claudeCanRun();
  }

  async launch(run: AgentRun): Promise<Launch> {
    const mcpConfig = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
    const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
    // --mcp-config and --allowedTools take several values, so each is followed by another flag.
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link", "mcp__loopway__end");
    // Resumed runs get it too: a session keeps its model only if the flag says so.
    args.push("--model", run.model, "--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
    // Sandboxed unless the user opted out, resumed runs included; Claude Code refuses to start if it can't be.
    if (run.sandbox !== false)
      args.push("--settings", JSON.stringify(claudeSandboxSettings(process.cwd(), await openProxyPort())));
    // The message goes in as stream-json so Claude Code can echo it back once it's in the session.
    args.push("--input-format", "stream-json", "--replay-user-messages");
    return {
      args,
      stdin: JSON.stringify({ type: "user", message: { role: "user", content: run.message } }) + "\n",
      // Node's fetch ignores HTTP(S)_PROXY unless told to, and the sandbox only lets commands out through the proxy:
      // without this `loopway` fails with ENOTFOUND.
      env: run.sandbox !== false ? { NODE_USE_ENV_PROXY: "1" } : undefined,
    };
  }

  watch(onStarted?: () => void) {
    return new LimitWatch(onStarted);
  }
}
