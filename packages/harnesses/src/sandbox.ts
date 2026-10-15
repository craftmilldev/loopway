import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

/** What a bot run may touch, whatever harness runs it. Paths starting with `~` are in the user's home directory. */
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

/** An absolute path for one of the policy's (`~` is the home directory). */
export const expandPath = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));

/** The git dir shared by the working directory's worktrees, if it lives outside the working directory. */
export function sharedGitDir(cwd: string): string | undefined {
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
