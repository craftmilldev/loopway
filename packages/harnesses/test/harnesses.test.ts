import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { LIMIT_FALLBACK_MS, LimitWatch } from "../src/claude-watch.js";
import { CursorWatch } from "../src/cursor.js";
import { getHarness, HARNESSES } from "../src/index.js";

const temp = () => mkdtemp(join(tmpdir(), "lw-harness-"));

describe("harnesses", () => {
  it("knows claude, cursor and bb, and refuses others", () => {
    expect(HARNESSES.map((h) => h.name)).toEqual(["claude", "cursor", "bb"]);
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

  it("BbHarness: spawns a thread with the run's MCP config, tells the same thread on resume, and cleans up", async () => {
    const bin = await temp();
    const out = await temp();
    // A stand-in for bb: records its calls and the MCP file the thread's workspace holds.
    const script = `#!/bin/sh
echo "$@" >> "${out}/calls"
case "$2" in
  spawn) cat > "${out}/prompt"; for a in "$@"; do if [ "$prev" = --environment ]; then cat "$a/.mcp.json" >> "${out}/mcp"; fi; prev="$a"; done
         echo '{"id":"thr_1"}' ;;
  tell) cat > /dev/null; echo '{}' ;;
  show) echo '{"thread":{"status":"idle"}}' ;;
  output) echo '{"output":"all done"}' ;;
  *) echo '{}' ;;
esac
`;
    await writeFile(join(bin, "bb"), script);
    await chmod(join(bin, "bb"), 0o755);
    const logPath = join(await temp(), "threads", "t1.log");
    let started = 0;
    const base: AgentRun = {
      harness: "bb",
      sessionId: "t1",
      resume: false,
      message: "hello",
      model: "sonnet",
      logPath,
      mcpUrl: "http://127.0.0.1:1/mcp/t1",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOOPWAY_BB_PROJECT: "proj_1" },
      onStarted: () => started++,
    };
    const harness = getHarness("bb");
    expect(await harness.run(base)).toMatchObject({ code: 0, delivered: true, finished: true });
    expect(await harness.run({ ...base, resume: true, message: "again" })).toMatchObject({ code: 0, finished: true });
    expect(started).toBe(2);
    const calls = await readFile(join(out, "calls"), "utf8");
    expect(calls).toContain("thread spawn --json --project proj_1 --environment");
    expect(calls).toContain("--model sonnet");
    expect(calls).toContain("thread tell thr_1 --mode auto");
    expect(await readFile(join(out, "mcp"), "utf8")).toContain('"url":"http://127.0.0.1:1/mcp/t1"');
    expect(await readFile(join(out, "prompt"), "utf8")).toContain("hello");
    expect(existsSync(`${logPath}.workspace`)).toBe(false);
    expect(await readFile(logPath, "utf8")).toContain("all done");

    // A bb that fails is an API error, not a crash.
    await writeFile(
      join(bin, "bb"),
      `#!/bin/sh\necho '{"ok":false,"error":{"message":"bb is not running"}}'\nexit 1\n`,
    );
    expect(await harness.run({ ...base, resume: false })).toMatchObject({
      code: 1,
      delivered: false,
      apiError: expect.stringContaining("bb is not running"),
    });
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
