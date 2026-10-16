import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { claudeCanRun, claudeSandboxSettings, ClaudeHarness } from "../src/claude.js";
import { LimitWatch } from "../src/claude-watch.js";
import { openProxyPort } from "../src/open-proxy.js";
import { sandboxPolicy } from "../src/sandbox.js";

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
  it.each([false, true])("claude runs with sandbox: false get no settings (resume=%s)", async (resume) => {
    const { args } = await new ClaudeHarness().launch({ ...run(resume), sandbox: false });
    expect(args).not.toContain("--settings");
    expect(args).toContain(resume ? "--resume" : "--session-id");
  });

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
    const s = claudeSandboxSettings("/nonexistent", 4321);
    expect(s.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining(["~/.npm", "~/.claude", "~/.loopway"]));
    // Claude's own proxy rejects `allowedDomains: ["*"]`, so open egress goes through ours.
    expect(s.sandbox.network).toEqual({ httpProxyPort: 4321 });
  });

  it("sandboxed runs reach the network through the open proxy, and Node's fetch is told to use it", async () => {
    const { args, env } = await new ClaudeHarness().launch(run(false));
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.sandbox.network.httpProxyPort).toBeGreaterThan(0);
    expect(settings.sandbox.network.allowedDomains).toBeUndefined();
    expect(env).toEqual({ NODE_USE_ENV_PROXY: "1" });
    expect((await new ClaudeHarness().launch({ ...run(false), sandbox: false })).env).toBeUndefined();
  });

  it("the open proxy tunnels HTTPS (CONNECT) and forwards plain HTTP to any host", async () => {
    const { createServer } = await import("node:http");
    const { connect } = await import("node:net");
    const target = createServer((_req, res) => res.end("hello")).listen(0, "127.0.0.1");
    await new Promise((r) => target.once("listening", r));
    const targetPort = (target.address() as { port: number }).port;
    const proxyPort = await openProxyPort();
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const s = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`));
        let data = "";
        s.on("data", (d) => {
          data += d;
          if (data.includes("200 Connection Established") && !data.includes("hello")) s.write("GET / HTTP/1.0\r\n\r\n");
          if (data.includes("hello")) (s.destroy(), resolve(data));
        });
        s.on("error", reject);
      });
      expect(reply).toContain("200 Connection Established");
      expect(reply).toContain("hello");
      const viaProxy = await new Promise<string>((resolve, reject) => {
        const s = connect(proxyPort, "127.0.0.1", () =>
          s.write(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`),
        );
        let data = "";
        s.on("data", (d) => (data += d));
        s.on("end", () => resolve(data));
        s.on("error", reject);
      });
      expect(viaProxy).toContain("hello");
    } finally {
      target.close();
    }
  });

  describe("write guard hook", () => {
    const guard = async (input: string) => {
      const cwd = await mkdtemp(join(tmpdir(), "lw-guard-"));
      await symlink(homedir(), join(cwd, "escape"));
      const command = claudeSandboxSettings(cwd, 4321).hooks.PreToolUse[0]!.hooks[0]!.command;
      const code = (payload: unknown) =>
        spawnSync("/bin/sh", ["-c", command], {
          input: typeof payload === "string" ? payload : JSON.stringify(payload),
        }).status;
      return { cwd, code, input };
    };

    it("denies when the guard can't even start", async () => {
      const { cwd } = await guard("");
      const command = claudeSandboxSettings(cwd, 4321).hooks.PreToolUse[0]!.hooks[0]!.command.replace(
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

  // The checked-in list of legitimate bot work (docs/sandbox.md); each row is a path an action writes.
  describe("legitimate work passes", () => {
    const guardCode = async (env: NodeJS.ProcessEnv, file: string) => {
      const cwd = await mkdtemp(join(tmpdir(), "lw-legit-"));
      const settings = claudeSandboxSettings(cwd, 4321, sandboxPolicy(env));
      const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
      const target = file.replace("<cwd>", cwd);
      return spawnSync("/bin/sh", ["-c", command], {
        input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: target } }),
      }).status;
    };
    const home = homedir();
    it.each([
      ["a file in the working directory or a worktree under it", "<cwd>/.claude/worktrees/issue-1/a.ts"],
      ["npm ci (npm cache)", join(home, ".npm/_cacache/index-v5/x")],
      ["tool caches (~/.cache)", join(home, ".cache/node/x")],
      ["macOS per-user caches", join(home, "Library/Caches/node-gyp/x")],
      ["node-gyp headers", join(home, ".node-gyp/22/x")],
      ["tool data and state", join(home, ".local/share/x/y")],
      ["tool state", join(home, ".local/state/x/y")],
      ["temp files", join(tmpdir(), "lw-legit-x")],
      ["Claude session files", join(home, ".claude/projects/p/s.jsonl")],
      ["loopway session logs", join(home, ".loopway/sessions/s.log")],
      ["gh's own config (GH_CONFIG_DIR=~/.loopway/gh)", join(home, ".loopway/gh/config.yml")],
    ])("%s", async (_what, file) => {
      expect(await guardCode({}, file)).toBe(0);
    });

    it("a cache the environment moves is resolved at run time", async () => {
      const moved = await mkdtemp(join(homedir(), "lw-moved-"));
      try {
        expect(await guardCode({}, join(moved, "x"))).toBe(2);
        for (const name of ["npm_config_cache", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
          expect(await guardCode({ [name]: moved }, join(moved, "x"))).toBe(0);
        }
        expect(await guardCode({ XDG_CACHE_HOME: "relative/dir" }, join(homedir(), "relative/dir/x"))).toBe(2);
      } finally {
        await rm(moved, { recursive: true, force: true });
      }
    });

    it.each([
      ["~/.ssh", join(home, ".ssh/id_x")],
      ["~/.aws", join(home, ".aws/credentials")],
      ["~/.gnupg", join(home, ".gnupg/x")],
      ["~/.config/gh", join(home, ".config/gh/hosts.yml")],
      ["~/.netrc", join(home, ".netrc")],
      ["the rest of $HOME", join(home, "lw-legit-outside")],
      ["~/.config", join(home, ".config/x/y")],
      ["Claude's settings", join(home, ".claude/settings.json")],
    ])("still denied: %s", async (_what, file) => {
      expect(await guardCode({}, file)).toBe(2);
    });

    it("keeps the secret paths unreadable and leaves them out of the write roots", () => {
      const p = sandboxPolicy({});
      expect(p.denyRead).toEqual(["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.netrc"]);
      expect(p.allowWrite).not.toEqual(expect.arrayContaining(["~", "~/.config", "~/.ssh"]));
    });
  });

  describe("denials in a run", () => {
    const toolError = (text: unknown, is_error = true) =>
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", is_error, content: text }] },
      });

    it("collects failed tool results that look like sandbox denials, up to a few", () => {
      const watch = new LimitWatch();
      watch.line(toolError("mkdir: /Users/x/foo: Operation not permitted"));
      watch.line(toolError([{ type: "text", text: "line one\ntouch: cannot touch 'a': Read-only file system" }]));
      watch.line(toolError("Writes outside the working directory are not allowed: /Users/x/y"));
      watch.line(toolError("npm ERR! 404 not found"));
      watch.line(toolError("Operation not permitted", false));
      expect(watch.denials()).toEqual([
        "mkdir: /Users/x/foo: Operation not permitted",
        "touch: cannot touch 'a': Read-only file system",
        "Writes outside the working directory are not allowed: /Users/x/y",
      ]);
      for (let i = 0; i < 10; i++) watch.line(toolError("Operation not permitted"));
      expect(watch.denials()).toHaveLength(5);
      expect(watch.delivered).toBe(false);
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
