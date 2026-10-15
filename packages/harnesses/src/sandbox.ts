import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** What a bot run may touch. Paths starting with `~` are in the user's home directory. */
export interface SandboxPolicy {
  /** Writes are allowed only here (the working directory and its git dir are always allowed too). */
  allowWrite: string[];
  /** Writes are denied here even inside `allowWrite`: what would change how later sessions behave. */
  denyWrite: string[];
  /** Reads are denied here, for commands and for the agent's own file tools. */
  denyRead: string[];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export const SANDBOX_POLICY: SandboxPolicy = {
  // Temp is resolved because /tmp and /var are symlinks on macOS, and the sandbox matches real paths.
  allowWrite: ["~/.npm", "~/.cache", "~/.claude", "~/.loopway", real("/tmp"), real(tmpdir())],
  denyWrite: [
    "~/.claude/settings.json",
    "~/.claude/settings.local.json",
    "~/.claude/CLAUDE.md",
    "~/.claude/hooks",
    "~/.claude/skills",
    "~/.claude/commands",
    "~/.claude/agents",
    "~/.claude/plugins",
    "~/.loopway/config.json",
    "~/.loopway/runner.json",
  ],
  denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.netrc"],
};

/** The git dir shared by the working directory's worktrees, if it lives outside the working directory. */
function sharedGitDir(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dir = resolve(cwd, out.trim());
    return dir === cwd || dir.startsWith(cwd + "/") ? undefined : dir;
  } catch {
    return undefined;
  }
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A hook that denies the file tools' writes outside the allowed roots (argv[1], a JSON list), since the sandbox only
 * covers commands. It resolves symlinks of the nearest existing parent so a link can't lead out.
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
  const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
  const guard = JSON.stringify({ roots: [cwd, ...allowWrite].map(expand), deny: policy.denyWrite.map(expand) });
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

export interface SandboxProblem {
  reason: "unsupported_platform" | "missing_dependency";
  /** What to tell the user, including what to install. */
  message: string;
}

/** Why Claude bots can't run here, with what to do about it; undefined if they can. */
export function sandboxProblem(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? "",
): SandboxProblem | undefined {
  if (platform === "darwin") return undefined;
  if (platform === "win32")
    return {
      reason: "unsupported_platform",
      message: "Claude bots run in a sandbox, which native Windows doesn't support. Run loopway inside WSL2 instead.",
    };
  if (platform !== "linux")
    return {
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
  if (!missing.length) return undefined;
  const pkgs = missing.join(" ");
  return {
    reason: "missing_dependency",
    message: `Claude bots run in a sandbox, which needs ${pkgs}. Install with \`sudo apt-get install ${pkgs}\` (or \`sudo dnf install ${pkgs}\`).`,
  };
}
