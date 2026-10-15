import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { LIMIT_FALLBACK_MS, LimitWatch } from "../src/claude-watch.js";
import { CursorWatch } from "../src/cursor.js";
import { HermesWatch, withoutTopLevelKey } from "../src/hermes.js";
import { getHarness, HARNESSES } from "../src/index.js";

const temp = () => mkdtemp(join(tmpdir(), "lw-harness-"));

describe("harnesses", () => {
  it("knows claude, cursor and hermes, and refuses others", () => {
    expect(HARNESSES.map((h) => h.name)).toEqual(["claude", "cursor", "hermes"]);
    expect(() => getHarness("codex")).toThrow(/Unknown harness "codex"/);
  });

  it("CursorWatch: init starts the session, a user record delivers, an error result is an API error", () => {
    let started = 0;
    const w = new CursorWatch(() => started++);
    w.line("not json");
    w.line(JSON.stringify({ type: "system", subtype: "init" }));
    w.line(JSON.stringify({ type: "user", message: {} }));
    expect([started, w.delivered, w.finished, w.apiError(), w.limitedUntil()]).toEqual([
      1,
      true,
      false,
      undefined,
      undefined,
    ]);
    w.line(JSON.stringify({ type: "result", is_error: true, result: "boom" }));
    expect([w.finished, w.apiError()]).toEqual([true, "boom"]);
  });

  it("CursorHarness: makes a chat, gives the run its own MCP config, resumes the chat, and cleans up", async () => {
    const bin = await temp();
    const out = await temp();
    // A stand-in for cursor-agent: create-chat prints an id; a run records its args and the MCP file it can see.
    const script = `#!/bin/sh
if [ "$1" = create-chat ]; then echo chat-123; exit 0; fi
echo "$@" >> "${out}/args"
for a in "$@"; do if [ "$prev" = --workspace ]; then cat "$a/.cursor/mcp.json" >> "${out}/mcp"; fi; prev="$a"; done
echo '{"type":"system","subtype":"init"}'
echo '{"type":"user"}'
echo '{"type":"result","is_error":false,"result":"ok"}'
`;
    await writeFile(join(bin, "cursor-agent"), script);
    await chmod(join(bin, "cursor-agent"), 0o755);
    const logPath = join(await temp(), "threads", "t1.log");
    let started = 0;
    const base: AgentRun = {
      harness: "cursor",
      sessionId: "t1",
      resume: false,
      message: "hello",
      model: "auto",
      logPath,
      mcpUrl: "http://127.0.0.1:1/mcp/t1",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      onStarted: () => started++,
    };
    const harness = getHarness("cursor");
    expect(await harness.run(base)).toMatchObject({ code: 0, delivered: true, finished: true });
    expect(await harness.run({ ...base, resume: true })).toMatchObject({ code: 0, finished: true });
    expect(started).toBe(2);

    // A resumed session whose chat id is gone gets a new chat rather than an ENOENT.
    await rm(`${logPath}.chat`);
    expect(await harness.run({ ...base, resume: true })).toMatchObject({ code: 0, finished: true });
    expect(await readFile(`${logPath}.chat`, "utf8")).toBe("chat-123\n");

    const args = (await readFile(join(out, "args"), "utf8")).trim().split("\n");
    expect(args).toHaveLength(3);
    for (const a of args) expect(a).toContain("--resume chat-123 --model auto");
    expect(args[0]).toMatch(/hello$/);
    expect(await readFile(join(out, "mcp"), "utf8")).toContain('"url":"http://127.0.0.1:1/mcp/t1"');
    expect(existsSync(`${logPath}.workspace`)).toBe(false);
    expect(await readFile(logPath, "utf8")).toContain('"subtype":"init"');
  });

  it("HermesWatch: init starts the session and delivers; a result with an error or exit code is an API error", () => {
    let started = 0;
    const w = new HermesWatch(() => started++);
    w.line("not json");
    w.line(JSON.stringify({ type: "system", subtype: "init" }));
    w.line(JSON.stringify({ type: "text", text: "hi" }));
    expect([started, w.delivered, w.finished, w.apiError()]).toEqual([1, true, false, undefined]);
    w.line(JSON.stringify({ type: "result", exit_code: 0, session_id: "s1" }));
    expect([w.finished, w.apiError()]).toEqual([true, undefined]);
    const failed = new HermesWatch();
    failed.line(JSON.stringify({ type: "result", exit_code: 1, error: "no key" }));
    expect(failed.apiError()).toBe("no key");
    const code = new HermesWatch();
    code.line(JSON.stringify({ type: "result", exit_code: 130 }));
    expect(code.apiError()).toMatch(/130/);
  });

  it("withoutTopLevelKey: drops the block under the key and nothing else", () => {
    const yaml = "model: x\nmcp_servers:\n  a:\n    url: u\n\n  b: 1\nagent:\n  y: 2\n";
    expect(withoutTopLevelKey(yaml, "mcp_servers")).toBe("model: x\nagent:\n  y: 2\n");
    expect(withoutTopLevelKey("model: x\n", "mcp_servers")).toBe("model: x\n");
    expect(withoutTopLevelKey("mcp_servers:\n- name: a\n- name: b\nmodel: x\n", "mcp_servers")).toBe("model: x\n");
  });

  it("HermesHarness: gives each session its own home with the loopway MCP server, and resumes in it", async () => {
    const bin = await temp();
    const out = await temp();
    const userHome = await temp();
    await writeFile(join(userHome, "config.yaml"), "model: m\nmcp_servers:\n  other:\n    url: x\n");
    await writeFile(join(userHome, ".env"), "KEY=1\n");
    // A stand-in for hermes: records its args, stdin and config, and keeps a state.db in its home like the real one.
    const script = `#!/bin/sh
echo "$@" >> "${out}/args"
cat >> "${out}/stdin"
cat "$HERMES_HOME/config.yaml" >> "${out}/config"
touch "$HERMES_HOME/state.db"
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","exit_code":0}'
`;
    await writeFile(join(bin, "hermes"), script);
    await chmod(join(bin, "hermes"), 0o755);
    const logPath = join(await temp(), "threads", "t1.log");
    let started = 0;
    const base: AgentRun = {
      harness: "hermes",
      sessionId: "t1",
      resume: false,
      message: "hello",
      model: "some-model",
      logPath,
      mcpUrl: "http://127.0.0.1:1/mcp/t1",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HERMES_HOME: userHome },
      onStarted: () => started++,
    };
    const harness = getHarness("hermes");
    expect(await harness.run(base)).toMatchObject({ code: 0, delivered: true, finished: true });
    expect(await harness.run({ ...base, resume: true })).toMatchObject({ code: 0, finished: true });
    expect(started).toBe(2);

    const args = (await readFile(join(out, "args"), "utf8")).trim().split("\n");
    expect(args[0]).toBe("chat --query-file - --format stream-json --yolo --model some-model");
    expect(args[1]).toBe(`${args[0]} --resume latest`);
    expect(await readFile(join(out, "stdin"), "utf8")).toBe("hellohello");
    const config = await readFile(join(out, "config"), "utf8");
    expect(config).toContain("model: m");
    expect(config).toContain('url: "http://127.0.0.1:1/mcp/t1"');
    expect(config).not.toContain("other");
    expect(await readFile(`${logPath}.home/.env`, "utf8")).toBe("KEY=1\n");

    // A resumed session whose home is gone starts a new session rather than failing.
    await rm(`${logPath}.home`, { recursive: true });
    await harness.run({ ...base, resume: true });
    const last = (await readFile(join(out, "args"), "utf8")).trim().split("\n").pop();
    expect(last).toBe(args[0]);
  });

  it("LimitWatch: sees our message echoed; a rejected rate_limit_event plus a usage_limit_reached result say when to retry", () => {
    const now = 1_700_000_000_000;
    const rejected = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: now / 1000 + 3600 },
    });
    const limited = JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached" });

    const w = new LimitWatch();
    w.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1 } }));
    w.line("not json (stderr noise)");
    // Tool results and subagent turns are user records too; only our echoed message counts as delivered.
    w.line(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }));
    w.line(JSON.stringify({ type: "user", parent_tool_use_id: "t1", message: { role: "user", content: "sub" } }));
    expect(w.delivered).toBe(false);
    w.line(JSON.stringify({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "hi" } }));
    expect(w.delivered).toBe(true);
    w.line(JSON.stringify({ type: "result", is_error: true, api_error: "other" }));
    expect(w.limitedUntil(now)).toBeUndefined();
    w.line(rejected);
    expect(w.limitedUntil(now)).toBeUndefined();
    w.line(limited);
    expect(w.limitedUntil(now)).toBe(now + 3600_000);

    // Without a reset time, or with one already past, it falls back to a fixed wait.
    const bare = new LimitWatch();
    bare.line(limited);
    expect(bare.limitedUntil(now)).toBe(now + LIMIT_FALLBACK_MS);
    const stale = new LimitWatch();
    stale.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1 } }));
    stale.line(limited);
    expect(stale.limitedUntil(now)).toBe(now + LIMIT_FALLBACK_MS);
  });

  it("LimitWatch: a result that is an API error is reported, unless it is the usage limit", () => {
    const w = new LimitWatch();
    expect(w.apiError()).toBeUndefined();
    w.line(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: Your computer went to sleep",
      }),
    );
    expect(w.apiError()).toBe("API Error: Your computer went to sleep");
    const limited = new LimitWatch();
    limited.line(JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "limit" }));
    expect(limited.apiError()).toBeUndefined();
    const fine = new LimitWatch();
    fine.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
    expect(fine.apiError()).toBeUndefined();
  });
});
