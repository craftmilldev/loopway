import { spawnSync } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { claudeCanRun, claudeSandboxSettings, ClaudeHarness } from "../src/claude.js";

const run = (resume: boolean): AgentRun => ({
  harness: "claude",
  sessionId: "s1",
  resume,
  message: "hi",
  model: "sonnet",
  logPath: "/tmp/x.log",
  mcpUrl: "http://127.0.0.1:1/mcp/s1",
  env: {},
});

describe("sandbox", () => {
  it.each([false, true])("claude runs always get sandbox settings (resume=%s)", (resume) => {
    const { args } = new ClaudeHarness().launch(run(resume));
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(settings.sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining(["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.netrc"]),
    );
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(~/.ssh/**)", "Edit(~/.aws/**)"]));
  });

  it("allows writes to caches and temp, and leaves the network open", () => {
    const s = claudeSandboxSettings("/nonexistent");
    expect(s.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining(["~/.npm", "~/.claude", "~/.loopway"]));
    expect(s.sandbox.network.allowedDomains).toEqual(["*"]);
  });

  describe("write guard hook", () => {
    const guard = async (input: string) => {
      const cwd = await mkdtemp(join(tmpdir(), "lw-guard-"));
      await symlink(homedir(), join(cwd, "escape"));
      const command = claudeSandboxSettings(cwd).hooks.PreToolUse[0]!.hooks[0]!.command;
      const code = (payload: unknown) =>
        spawnSync("/bin/sh", ["-c", command], {
          input: typeof payload === "string" ? payload : JSON.stringify(payload),
        }).status;
      return { cwd, code, input };
    };

    it("denies when the guard can't even start", async () => {
      const { cwd } = await guard("");
      const command = claudeSandboxSettings(cwd).hooks.PreToolUse[0]!.hooks[0]!.command.replace(
        "write-guard.mjs",
        "missing.mjs",
      );
      expect(spawnSync("/bin/sh", ["-c", command], { input: "{}" }).status).toBe(2);
    });

    it("allows the working directory and temp, denies everything else, and fails closed", async () => {
      const { cwd, code } = await guard("");
      const write = (file_path?: string) => ({ tool_name: "Write", tool_input: { file_path } });
      expect(code(write(join(cwd, "a.txt")))).toBe(0);
      expect(code(write(join(cwd, "new/dir/b.txt")))).toBe(0);
      expect(code(write("/tmp/lw-guard-ok"))).toBe(0);
      expect(code(write(join(homedir(), "lw-guard-x")))).toBe(2);
      expect(code(write(join(cwd, "escape", "lw-guard-x")))).toBe(2);
      expect(code(write(join(homedir(), ".claude", "settings.json")))).toBe(2);
      expect(code(write(join(homedir(), ".claude", "projects", "x.jsonl")))).toBe(0);
      expect(code(write(undefined))).toBe(2);
      expect(code("not json")).toBe(2);
    });
  });

  it("names what's missing, and sends Windows to WSL2", () => {
    expect(claudeCanRun("darwin")).toEqual({ ok: true });
    expect(claudeCanRun("win32")).toMatchObject({ ok: false, message: expect.stringMatching(/WSL2/) });
    expect(claudeCanRun("linux", "/nonexistent")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/bubblewrap socat/),
    });
  });
});
