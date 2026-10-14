import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/bots/agent.js";
import { CursorWatch } from "../src/bots/harnesses/cursor.js";
import { getHarness, HARNESSES } from "../src/bots/harnesses/index.js";

const temp = () => mkdtemp(join(tmpdir(), "lw-harness-"));

describe("harnesses", () => {
  it("knows claude and cursor, and refuses others", () => {
    expect(HARNESSES.map((h) => h.name)).toEqual(["claude", "cursor"]);
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
});
