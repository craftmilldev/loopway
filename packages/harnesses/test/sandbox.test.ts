import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { ClaudeHarness } from "../src/claude.js";
import { claudeSandboxSettings, sandboxProblem } from "../src/sandbox.js";

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
  it.each([false, true])("claude runs always get sandbox settings (resume=%s)", async (resume) => {
    const { args } = await new ClaudeHarness().launch(run(resume));
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

  it("names what's missing, and sends Windows to WSL2", () => {
    expect(sandboxProblem("darwin")).toBeUndefined();
    expect(sandboxProblem("win32")?.message).toMatch(/WSL2/);
    expect(sandboxProblem("linux", "/nonexistent")?.message).toMatch(/bubblewrap socat/);
  });
});
