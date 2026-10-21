import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun, RunOutcome } from "@loopway/harnesses";
import { MANAGER_PROMPT } from "@loopway/presets";
import { emptyChat, ManagerChat, type ManagerChatOptions } from "../src/bots/chat.js";

const rec = (r: object) => JSON.stringify(r) + "\n";
const reply = (text: string) => rec({ type: "assistant", message: { content: [{ type: "text", text }] } });
const init = rec({ type: "system", subtype: "init" });

/** A fake harness: records each run, writes what `script` says to the log, and returns its outcome. */
function fake(
  script: (run: AgentRun, n: number) => Promise<Partial<RunOutcome> | string> | Partial<RunOutcome> | string,
) {
  const runs: AgentRun[] = [];
  const runAgent = async (run: AgentRun): Promise<RunOutcome> => {
    runs.push(run);
    // The real harness makes the log directory.
    await mkdir(dirname(run.logPath), { recursive: true });
    const out = await script(run, runs.length);
    const outcome = typeof out === "string" ? {} : out;
    if (typeof out === "string") {
      run.onStarted?.();
      await appendFile(run.logPath, init + reply(out));
    }
    return { code: 0, delivered: true, finished: true, ...outcome };
  };
  return { runs, runAgent };
}

async function manager(runAgent: ManagerChatOptions["runAgent"], more: Partial<ManagerChatOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "chat-"));
  const events: [string, unknown][] = [];
  const chat = new ManagerChat({
    org: "acme",
    dir,
    env: {},
    harness: "claude",
    runAgent,
    capture: (e, p) => void events.push([e, p]),
    ...more,
  });
  return { chat, dir, events };
}

describe("chat", () => {
  it("starts empty", () => {
    expect(emptyChat()).toEqual({ messages: [], thinking: false });
  });

  it("is the org's bot, with an id derived from the org", async () => {
    const { chat } = await manager(fake(() => "").runAgent);
    expect(chat.botId).toBe("manager:acme");
  });

  it("starts a read-only session on the first message and replies from its transcript", async () => {
    const { runs, runAgent } = fake(() => "You have 2 bots.");
    const { chat, dir, events } = await manager(runAgent, { model: "sonnet" });
    const sent = chat.send("  what bots do I have?  ");
    expect(sent.result).toBe("sent");
    // The message and the thinking state show right away.
    expect(await chat.read()).toEqual({ messages: [{ from: "you", text: "what bots do I have?" }], thinking: true });
    await sent.done;

    expect(await chat.read()).toEqual({
      messages: [
        { from: "you", text: "what bots do I have?" },
        { from: "manager", text: "You have 2 bots.", kind: "text" },
      ],
      thinking: false,
    });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ harness: "claude", model: "sonnet", resume: false, env: {} });
    expect(run.message).toBe(`${MANAGER_PROMPT}\n\nwhat bots do I have?`);
    // Only read-only loopway commands are allowed, and changing threads is denied outright.
    expect(run.allowedTools).toContain("Bash(loopway bots list:*)");
    expect(run.allowedTools!.join(" ")).not.toMatch(/Bash\(loopway bots (create|update|edit|delete)/);
    expect(run.deniedTools).toContain("Bash(loopway bots threads end:*)");
    // The transcript is kept under the config dir, like a thread's.
    expect(run.logPath.startsWith(join(dir, "chats"))).toBe(true);
    expect(await readFile(run.logPath, "utf8")).toContain("You have 2 bots.");
    expect(events).toEqual([["manager_reply_finished", { harness: "claude" }]]);
  });

  it("resumes the same session for the next message, without the prompt again", async () => {
    const { runs, runAgent } = fake((_run, n) => `answer ${n}`);
    const { chat } = await manager(runAgent);
    await chat.send("one").done;
    await chat.send("two").done;
    expect(runs.map((r) => r.resume)).toEqual([false, true]);
    expect(runs[1]!.sessionId).toBe(runs[0]!.sessionId);
    expect(runs[1]!.message).toBe("two");
    expect(runs[1]!.logPath).toBe(runs[0]!.logPath);
    // Each turn shows only its own output.
    expect((await chat.read()).messages.map((m) => m.text)).toEqual(["one", "answer 1", "two", "answer 2"]);
  });

  it("runs on the harness and model it is configured with", async () => {
    const { runs, runAgent } = fake(() => "ok");
    const { chat } = await manager(runAgent, { harness: "codex", model: "gpt-6-sol" });
    await chat.send("hi").done;
    expect(runs[0]).toMatchObject({ harness: "codex", model: "gpt-6-sol" });
    const other = fake(() => "ok");
    const { chat: second } = await manager(other.runAgent, { harness: "cursor" });
    await second.send("hi").done;
    expect(other.runs[0]).toMatchObject({ harness: "cursor", model: "" });
  });

  it("ignores empty messages and messages sent while a run is in flight", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const { runs, runAgent } = fake(async () => {
      await gate;
      return "done";
    });
    const { chat } = await manager(runAgent);
    expect(chat.send(" \t ").result).toBe("empty");
    const first = chat.send("first");
    expect(chat.send("second").result).toBe("busy");
    finish();
    await first.done;
    expect(runs).toHaveLength(1);
    expect((await chat.read()).messages.map((m) => m.text)).toEqual(["first", "done"]);
  });

  it("shows a failed run in the chat and takes the next message", async () => {
    const { runs, runAgent } = fake((_run, n) => (n === 1 ? { code: 2 } : "back"));
    const { chat, events } = await manager(runAgent);
    await chat.send("one").done;
    const failed = await chat.read();
    expect(failed.thinking).toBe(false);
    expect(failed.messages.at(-1)).toMatchObject({ from: "manager", kind: "error" });
    expect(failed.messages.at(-1)!.text).toContain("exit code 2");
    // The session never started, so the next message starts a fresh one, with the prompt.
    await chat.send("two").done;
    expect(runs[1]).toMatchObject({ resume: false });
    expect(runs[1]!.sessionId).not.toBe(runs[0]!.sessionId);
    expect(runs[1]!.message).toContain(MANAGER_PROMPT);
    expect((await chat.read()).messages.at(-1)).toMatchObject({ text: "back" });
    expect(events[0]).toEqual(["manager_run_failed", { harness: "claude", reason: "exit_code" }]);
  });

  it("shows a harness that throws, an API error and the usage limit", async () => {
    const throws = await manager(async () => {
      throw new Error("claude: command not found");
    });
    await throws.chat.send("hi").done;
    expect((await throws.chat.read()).messages.at(-1)!.text).toBe(
      "The manager couldn't run: claude: command not found",
    );
    expect(throws.events).toEqual([["manager_run_failed", { harness: "claude", reason: "start_failed" }]]);

    const api = await manager(fake(() => ({ apiError: "API Error: overloaded" })).runAgent);
    await api.chat.send("hi").done;
    expect((await api.chat.read()).messages.at(-1)!.text).toContain("overloaded");
    expect(api.events[0]![1]).toMatchObject({ reason: "api_error" });

    const limited = await manager(fake(() => ({ limitedUntil: Date.now() + 1000 })).runAgent);
    await limited.chat.send("hi").done;
    expect((await limited.chat.read()).messages.at(-1)!.text).toContain("usage limit");
    expect(limited.events[0]![1]).toMatchObject({ reason: "usage_limit" });
  });

  it("works with a runner that has no bots: nothing but its own session is needed", async () => {
    const { runs, runAgent } = fake(() => "You have no bots yet.");
    const { chat } = await manager(runAgent);
    await chat.send("what bots do I have?").done;
    expect((await chat.read()).messages.at(-1)!.text).toBe("You have no bots yet.");
    expect(runs[0]!.mcpUrl).toMatch(/^http/);
  });

  it("imports no ink, so a web UI can reuse it", async () => {
    const src = await readFile(new URL("../src/bots/chat.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](ink|react)/);
  });
});
