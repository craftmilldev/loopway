import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { AgentRun } from "./agent.js";
import { LimitWatch } from "./claude-watch.js";
import { Harness, type CanRun, type Launch } from "./harness.js";
import { expandPath, SANDBOX_POLICY, sharedGitDir, type SandboxPolicy } from "./sandbox.js";

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A hook that denies the file tools' writes outside the allowed roots or inside the denied ones (argv[1], JSON
 * `{ roots, deny }`), since Claude Code's sandbox only covers commands. It resolves symlinks of the nearest existing
 * parent so a link can't lead out. Claude Code only blocks on exit code 2, so anything unexpected exits 2 too.
 */
const WRITE_GUARD = `
const fs = require("fs"), path = require("path");
const within = (t, r) => t === r || t.startsWith(r + path.sep);
const real = (r) => { try { return fs.realpathSync(r); } catch { return r; } };
try {
  const cfg = JSON.parse(process.argv[1]);
  const roots = cfg.roots.map(real), deny = cfg.deny.map(real);
  let input = "";
  process.stdin.on("data", (d) => (input += d)).on("end", () => {
    try {
      const ti = JSON.parse(input).tool_input || {};
      const file = ti.file_path || ti.notebook_path;
      if (typeof file !== "string" || !file) throw new Error("no path");
      let p = path.resolve(file), tail = "";
      while (!fs.existsSync(p) && path.dirname(p) !== p) { tail = path.join(path.basename(p), tail); p = path.dirname(p); }
      const target = path.join(real(p), tail);
      if (roots.some((r) => within(target, r)) && !deny.some((d) => within(target, d))) process.exit(0);
      console.error("Writes outside the working directory, git dir, temp and tool caches are not allowed: " + file);
    } catch (e) {
      console.error("Write guard could not check this write: " + e.message);
    }
    process.exit(2);
  });
} catch (e) {
  console.error("Write guard failed: " + e.message);
  process.exit(2);
}
`;

/** The `--settings` value that puts a Claude Code run in its sandbox, with the network left open. */
export function claudeSandboxSettings(cwd: string, policy: SandboxPolicy = SANDBOX_POLICY) {
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
          hooks: [{ type: "command", command: `${shq(process.execPath)} -e ${shq(WRITE_GUARD)} ${shq(guard)}` }],
        },
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // A command that fails in the sandbox must not be retried outside it.
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite, denyWrite: policy.denyWrite, denyRead: policy.denyRead },
      // No domain restrictions. Allowing every domain up front means a headless run is never prompted or blocked.
      network: { allowedDomains: ["*"] },
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

  /** Claude runs only in its sandbox, so it can't run where the sandbox can't. */
  canRun(): CanRun {
    return claudeCanRun();
  }

  launch(run: AgentRun): Launch {
    const mcpConfig = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
    const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
    // --mcp-config and --allowedTools take several values, so each is followed by another flag.
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link", "mcp__loopway__end");
    // Resumed runs get it too: a session keeps its model only if the flag says so.
    args.push("--model", run.model, "--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
    // Always sandboxed, resumed runs included; Claude Code refuses to start if it can't be.
    args.push("--settings", JSON.stringify(claudeSandboxSettings(process.cwd())));
    // The message goes in as stream-json so Claude Code can echo it back once it's in the session.
    args.push("--input-format", "stream-json", "--replay-user-messages");
    return { args, stdin: JSON.stringify({ type: "user", message: { role: "user", content: run.message } }) + "\n" };
  }

  watch(onStarted?: () => void) {
    return new LimitWatch(onStarted);
  }
}
