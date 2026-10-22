import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun, RunOutcome } from "@loopway/harnesses";
import { MANAGER_PROMPT } from "@loopway/presets";
import { emptyChat, ManagerChat, type ChatThreads, type ManagerChatOptions } from "../src/bots/chat.js";
import { chatLabel } from "../src/bots/chat-label.js";
import { ApiError } from "../src/client.js";
import { reservedChatKey } from "../src/commands/bots-run.js";
import { parseProposal, tokenize, type Proposal } from "../src/bots/chat-changes.js";

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
    // Claude Code's own read-only tools are denied too, so the runner's directory stays out of reach.
    for (const t of ["Read", "Grep", "Glob", "WebFetch", "Bash(cat:*)"]) expect(run.deniedTools).toContain(t);
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

  it("warns once, in the chat, when the harness can't enforce the read-only tool list", async () => {
    const { runAgent } = fake(() => "ok");
    const { chat, events } = await manager(runAgent, { harness: "codex" });
    await chat.send("one").done;
    await chat.send("two").done;
    const notices = (await chat.read()).messages.filter((m) => m.text.includes("can't enforce"));
    expect(notices).toHaveLength(1);
    expect(events).toContainEqual(["manager_unenforced_harness", { harness: "codex" }]);

    const claude = await manager(fake(() => "ok").runAgent);
    await claude.chat.send("one").done;
    expect((await claude.chat.read()).messages.some((m) => m.text.includes("can't enforce"))).toBe(false);
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

  describe("changes", () => {
    const propose = (command: string, extra = "") =>
      "Here is what I'll do.\n\n```loopway-change\n" + command + extra + "\n```";
    const CREATE =
      "loopway bots create --name triage --preset github-threads --model sonnet --harness claude --inbox gh";
    const parsed = (block: string): Proposal => {
      const p = parseProposal(block);
      if (!p.ok) throw new Error(p.text);
      return p.proposal;
    };
    /** A runner with a fake `loopway`: records the commands it is asked to run. */
    function commands(code = 0, output = "Created bot triage") {
      const ran: { args: string[]; files: Record<string, string> }[] = [];
      return {
        ran,
        runCommand: async (args: string[]) => {
          const files: Record<string, string> = {};
          for (const a of args) if (a.startsWith("/")) files[a] = await readFile(a, "utf8");
          ran.push({ args, files });
          return { code, output };
        },
      };
    }

    it("proposes a change, runs nothing until approved, then runs exactly that command and logs it", async () => {
      const { ran, runCommand } = commands();
      const { runs, runAgent } = fake((_run, n) => (n === 1 ? propose(CREATE) : "Done: triage exists."));
      const { chat, dir, events } = await manager(runAgent, { runCommand });
      await chat.send("create a bot named triage on inbox gh").done;

      const waiting = await chat.read();
      expect(waiting.pending).toMatchObject({ command: CREATE, kind: "create", name: "triage" });
      expect(ran).toEqual([]);
      // The session itself never gets the change commands.
      expect(runs[0]!.allowedTools!.join(" ")).not.toMatch(/bots (create|update|edit|delete)|inbox create/);
      expect(runs[0]!.deniedTools).toContain("Bash(loopway bots create:*)");
      expect(runs[0]!.deniedTools).toContain("Bash(loopway bots delete:*)");
      // A message sent while the proposal waits is ignored.
      expect(chat.send("hello").result).toBe("busy");

      const { result, done } = chat.answer(true);
      expect(result).toBe("answered");
      await done;
      expect(ran.map((r) => r.args)).toEqual([CREATE.split(" ").slice(1)]);
      const after = await chat.read();
      expect(after.pending).toBeUndefined();
      expect(after.messages.map((m) => m.text)).toEqual([
        "create a bot named triage on inbox gh",
        "Here is what I'll do.\n\n```loopway-change\n" + CREATE + "\n```",
        `ran: ${CREATE}\nCreated bot triage`,
        "Done: triage exists.",
      ]);
      // The manager was told how it went, in the same session.
      expect(runs[1]).toMatchObject({ resume: true });
      expect(runs[1]!.message).toContain("approved it and it ran");
      expect(runs[1]!.message).toContain("Created bot triage");

      const log = await readFile(join(dir, "chats", `${runs[0]!.sessionId}.changes.jsonl`), "utf8");
      expect(JSON.parse(log)).toMatchObject({ kind: "create", target: "bot", name: "triage", ok: true });
      expect(events).toContainEqual(["manager_change_proposed", { kind: "create", target: "bot" }]);
      expect(events).toContainEqual(["manager_change_done", { kind: "create", target: "bot" }]);
    });

    it("runs nothing on a no, and tells the manager so it can acknowledge", async () => {
      const { ran, runCommand } = commands();
      const { runs, runAgent } = fake((_run, n) =>
        n === 1 ? propose("loopway bots delete triage") : "Okay, I left it.",
      );
      const { chat, events } = await manager(runAgent, { runCommand });
      await chat.send("delete triage").done;
      expect((await chat.read()).pending).toMatchObject({ kind: "delete", name: "triage" });
      await chat.answer(false).done;
      expect(ran).toEqual([]);
      expect(runs[1]!.message).toContain("denied");
      expect(runs[1]!.message).toContain("nothing ran");
      expect((await chat.read()).messages.at(-1)!.text).toBe("Okay, I left it.");
      expect(events).toContainEqual(["manager_change_denied", { kind: "delete", target: "bot" }]);
      expect(chat.answer(true).result).toBe("none");
    });

    it("refuses to run a change that wasn't approved, and an approval works once for that exact command", async () => {
      const { ran, runCommand } = commands();
      const { chat } = await manager(fake(() => "").runAgent, { runCommand });
      const proposal = parsed("loopway bots delete triage");
      expect(await chat.execute(proposal)).toMatchObject({ ok: false, reason: "not_approved" });
      expect(ran).toEqual([]);
      // Approving one command doesn't approve another.
      const { runAgent } = fake((_run, n) => (n === 1 ? propose("loopway bots delete triage") : "ok"));
      const second = await manager(runAgent, { runCommand });
      await second.chat.send("x").done;
      await second.chat.answer(true).done;
      expect(ran).toHaveLength(1);
      expect(await second.chat.execute(proposal)).toMatchObject({ ok: false, reason: "not_approved" });
      expect(await second.chat.execute(parsed("loopway bots delete other"))).toMatchObject({ reason: "not_approved" });
      expect(ran).toHaveLength(1);
    });

    it("refuses commands outside the allowed list, without asking the user", async () => {
      const { ran, runCommand } = commands();
      const { chat, events } = await manager(
        fake((_run, n) => (n === 1 ? propose("loopway bots release triage --force") : "ok")).runAgent,
        { runCommand },
      );
      await chat.send("free it").done;
      const read = await chat.read();
      expect(read.pending).toBeUndefined();
      expect(read.messages.at(-1)).toMatchObject({ kind: "error" });
      expect(read.messages.at(-1)!.text).toContain("may not run");
      expect(events).toContainEqual(["manager_change_refused", { reason: "not_allowed" }]);
      expect(ran).toEqual([]);
      for (const bad of [
        "loopway threads end x",
        "loopway bots threads end triage t1",
        "loopway bots rm triage",
        "rm -rf /",
        "loopway bots delete triage; rm -rf /",
        "loopway bots delete $(whoami)",
        "loopway bots create --name x > /etc/passwd",
        "loopway bots edit triage --prompt-file /etc/passwd",
        "loopway inbox create --name x --schema /etc/passwd",
      ])
        expect(parseProposal(bad)).toMatchObject({ ok: false });
      expect(
        await chat.execute({
          ...parsed("loopway bots delete a"),
          command: "loopway bots release a",
          args: ["bots", "release", "a"],
        }),
      ).toMatchObject({
        ok: false,
        reason: "not_allowed",
      });
    });

    it("saves a prompt and rules the manager wrote, from files only it can fill, after approval", async () => {
      const { ran, runCommand } = commands(0, "Saved version 2");
      const block = propose(
        "loopway bots edit triage --prompt-file @prompt --rules-file @rules",
        '\n@prompt\nYou triage issues.\n@rules\n{"assign": []}',
      );
      const { chat } = await manager(fake((_run, n) => (n === 1 ? block : "Saved.")).runAgent, { runCommand });
      await chat.send("write the prompt").done;
      const pending = (await chat.read()).pending!;
      expect(pending).toMatchObject({
        kind: "update",
        name: "triage",
        files: { "@prompt": "You triage issues.\n", "@rules": '{"assign": []}\n' },
      });
      expect(pending.effect).toContain("prompt and rules");
      await chat.answer(true).done;
      expect(ran).toHaveLength(1);
      expect(Object.values(ran[0]!.files).sort()).toEqual(["You triage issues.\n", '{"assign": []}\n']);
      expect(ran[0]!.args.slice(0, 3)).toEqual(["bots", "edit", "triage"]);
    });

    it("shows a failed change and logs it as not ok", async () => {
      const { runCommand } = commands(1, "Error: no such inbox");
      const { runs, runAgent } = fake((_run, n) => (n === 1 ? propose(CREATE) : "That failed."));
      const { chat, dir, events } = await manager(runAgent, { runCommand });
      await chat.send("go").done;
      await chat.answer(true).done;
      const messages = (await chat.read()).messages;
      expect(messages.find((m) => m.text.startsWith("failed:"))).toMatchObject({ kind: "error" });
      expect(
        JSON.parse(await readFile(join(dir, "chats", `${runs[0]!.sessionId}.changes.jsonl`), "utf8")),
      ).toMatchObject({ ok: false });
      expect(events).toContainEqual(["manager_change_failed", { kind: "create", target: "bot", reason: "failed" }]);
    });

    it("takes only the first of several proposals and tells the manager", async () => {
      const { runs, runAgent } = fake((_run, n) =>
        n === 1 ? propose("loopway bots delete a") + "\n" + propose("loopway bots delete b") : "ok",
      );
      const { chat } = await manager(runAgent, { runCommand: commands().runCommand });
      await chat.send("x").done;
      expect((await chat.read()).pending!.command).toBe("loopway bots delete a");
      await chat.answer(false).done;
      expect(runs[1]!.message).toContain("Only your first proposal");
    });

    it("names the bot only when it follows the verb, not an option's value", () => {
      expect(parsed("loopway bots update --name new-name triage").name).toBeUndefined();
      expect(parsed("loopway bots edit --prompt-file @prompt triage\n@prompt\nhi").name).toBeUndefined();
      expect(parsed("loopway bots update triage --name new-name").name).toBe("triage");
    });

    it("tells the manager about a refused proposal on the next message even if that run fails", async () => {
      const { runs, runAgent } = fake((_run, n) =>
        n === 1 ? propose("loopway bots release a") : n === 2 ? { code: 2 } : "ok",
      );
      const { chat } = await manager(runAgent);
      await chat.send("one").done;
      await chat.send("two").done;
      await chat.send("three").done;
      expect(runs[1]!.message).toContain("was refused");
      expect(runs[2]!.message).toContain("was refused");
    });

    it("tokenizes quotes without expanding anything", () => {
      expect(tokenize(`loopway bots create --name "my bot" --model 'a b'`)).toEqual([
        "loopway",
        "bots",
        "create",
        "--name",
        "my bot",
        "--model",
        "a b",
      ]);
      expect(tokenize("loopway bots delete a && b")).toBeUndefined();
      expect(tokenize('loopway "unterminated')).toBeUndefined();
    });
  });

  it("imports no ink, so a web UI can reuse it", async () => {
    const src = await readFile(new URL("../src/bots/chat.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](ink|react)/);
  });
});

describe("chatLabel", () => {
  const did = (...kinds: string[]) => kinds.map((kind) => ({ kind: kind as "create", ok: true }));

  it("is generic with no counts when nothing changed", () => {
    expect(chatLabel([])).toEqual({ label: "generic", actions: {} });
  });

  it("is the most frequent kind, with a count per kind", () => {
    expect(chatLabel(did("create", "create", "delete"))).toEqual({
      label: "create",
      actions: { create: 2, delete: 1 },
    });
    expect(chatLabel(did("update", "delete", "delete", "delete"))).toEqual({
      label: "delete",
      actions: { update: 1, delete: 3 },
    });
  });

  it("gives a tie to the kind done first", () => {
    expect(chatLabel(did("delete", "create", "create", "delete")).label).toBe("delete");
    expect(chatLabel(did("update", "create")).label).toBe("update");
  });

  it("counts only changes that succeeded", () => {
    expect(chatLabel([{ kind: "create", ok: false }])).toEqual({ label: "generic", actions: {} });
    expect(chatLabel([{ kind: "create", ok: false }, ...did("delete")])).toEqual({
      label: "delete",
      actions: { delete: 1 },
    });
  });
});

describe("chat threads", () => {
  /** A fake server: the manager threads the chat made, with their metadata and status. */
  function server(failCreate = 0) {
    const threads = new Map<string, { status: string; metadata: Record<string, unknown> }>();
    const calls: string[] = [];
    let creates = failCreate;
    const api: ChatThreads = {
      create: async (id) => {
        calls.push("create");
        if (creates-- > 0) throw new ApiError(409, "runner_not_leased", "no lease");
        threads.set(id, { status: "active", metadata: {} });
      },
      patch: async (id, patch) => {
        calls.push("patch");
        const t = threads.get(id);
        if (!t) throw new ApiError(404, "not_found", "no thread");
        if (patch.status) t.status = patch.status;
        Object.assign(t.metadata, patch.metadata_set);
      },
      mcpUrl: (id) => `http://127.0.0.1:1/secret/${id}`,
    };
    return { api, threads, calls };
  }

  const CREATE = (n: number) =>
    `loopway bots create --name bot${n} --preset github-threads --model sonnet --harness claude --inbox gh`;
  const propose = (command: string) => "Here is what I'll do.\n\n```loopway-change\n" + command + "\n```";
  const ok = async () => ({ code: 0, output: "done" });

  describe("/new", () => {
    it("clears the transcript, ends the old thread with its label, and the next message is a new session", async () => {
      const { api, threads } = server();
      const script = [propose(CREATE(1)), "Created.", "Hello again."];
      const { runs, runAgent } = fake((_run, n) => script[n - 1]!);
      const { chat, events } = await manager(runAgent, { threads: api, runCommand: ok });
      await chat.send("make a bot").done;
      await chat.answer(true).done;
      const [oldId] = [...threads.keys()];

      const sent = chat.send(" /new ");
      expect(sent.result).toBe("new");
      await sent.done;
      expect(await chat.read()).toEqual({ messages: [], thinking: false });
      // The old chat is ended and keeps its label.
      expect(threads.get(oldId!)).toEqual({ status: "ended", metadata: { label: "create", actions: { create: 1 } } });

      await chat.send("hi").done;
      expect(runs).toHaveLength(3);
      expect(runs[2]).toMatchObject({ resume: false });
      expect(runs[2]!.sessionId).not.toBe(runs[0]!.sessionId);
      expect(runs[2]!.logPath).not.toBe(runs[0]!.logPath);
      expect(runs[2]!.message).toBe(`${MANAGER_PROMPT}\n\nhi`);
      expect((await chat.read()).messages.map((m) => m.text)).toEqual(["hi", "Hello again."]);
      const [, newId] = [...threads.keys()];
      expect(newId).not.toBe(oldId);
      expect(threads.get(newId!)!.status).toBe("active");
      expect(events).toContainEqual(["manager_chat_new", { pending: false, thread: true }]);

      // Closing ends only the current chat's thread, with its own (empty) label.
      await chat.close();
      expect(threads.get(newId!)).toEqual({ status: "ended", metadata: { label: "generic", actions: {} } });
      expect(threads.get(oldId!)!.metadata).toEqual({ label: "create", actions: { create: 1 } });
    });

    it("cancels a change awaiting approval: nothing runs, and it can't be approved later", async () => {
      const commands: string[][] = [];
      const { chat, events } = await manager(fake(() => propose(CREATE(1))).runAgent, {
        runCommand: async (args) => (commands.push(args), { code: 0, output: "" }),
      });
      await chat.send("make a bot").done;
      expect((await chat.read()).pending).toBeDefined();
      expect(chat.send("/new").result).toBe("new");
      expect((await chat.read()).pending).toBeUndefined();
      expect(chat.answer(true).result).toBe("none");
      expect(commands).toEqual([]);
      expect(events).toContainEqual(["manager_chat_new", { pending: true, thread: false }]);
    });

    it("does nothing while a run is in flight, and a chat that never started has no thread to end", async () => {
      const { api, calls } = server();
      const { chat } = await manager(fake(() => "ok").runAgent, { threads: api });
      expect(chat.send("/new").result).toBe("new");
      expect(calls).toEqual([]);
      const first = chat.send("hello");
      expect(chat.send("/new").result).toBe("busy");
      await first.done;
    });
  });

  it("makes no thread before the first message, then one the runner owns, with the record tools bound to it", async () => {
    const { api, threads, calls } = server();
    const { runs, runAgent } = fake(() => "Hi.");
    const { chat, events } = await manager(runAgent, { threads: api });
    expect(calls).toEqual([]);
    await chat.send("hello").done;
    await chat.send("again").done;

    // One thread, id the chat's session id, created before the manager ran and labelled generic at once.
    expect(calls).toEqual(["create", "patch"]);
    const [id] = [...threads.keys()];
    expect(id).toBe(runs[0]!.sessionId);
    expect(threads.get(id!)).toEqual({ status: "active", metadata: { label: "generic", actions: {} } });
    for (const run of runs) {
      expect(run.mcpUrl).toBe(`http://127.0.0.1:1/secret/${id}`);
      expect(run.mcpTools).toEqual(["record", "unrecord"]);
    }
    expect(events).toContainEqual(["manager_thread_created", {}]);
  });

  it("makes no thread, and gives the manager no MCP tools, without threads (the manager flag off never builds a chat)", async () => {
    const { runs, runAgent } = fake(() => "Hi.");
    const { chat } = await manager(runAgent);
    await chat.send("hello").done;
    await chat.close();
    expect(runs[0]!.mcpTools).toBeUndefined();
    expect(runs[0]!.mcpUrl).toBe("http://127.0.0.1:1/mcp/manager");
  });

  it("labels a chat that only asked questions generic when it closes, and ends the thread", async () => {
    const { api, threads } = server();
    const { chat } = await manager(fake(() => "You have 2 bots.").runAgent, { threads: api });
    await chat.send("what bots do I have?").done;
    await chat.close();
    expect([...threads.values()]).toEqual([{ status: "ended", metadata: { label: "generic", actions: {} } }]);
  });

  it("labels a chat that created two bots and deleted one `create`, after each change and at the end", async () => {
    const { api, threads } = server();
    const script = [propose(CREATE(1)), propose(CREATE(2)), propose("loopway bots delete bot1"), "All done."];
    const { chat, events } = await manager(fake((_run, n) => script[n - 1]!).runAgent, {
      threads: api,
      runCommand: ok,
    });
    await chat.send("make two bots and drop the first").done;
    const metadata = () => [...threads.values()][0]!.metadata;
    await chat.answer(true).done;
    expect(metadata()).toEqual({ label: "create", actions: { create: 1 } });
    await chat.answer(true).done;
    await chat.answer(true).done;
    // Before it closes, the thread is already labelled.
    expect(metadata()).toEqual({ label: "create", actions: { create: 2, delete: 1 } });
    await chat.close();
    expect([...threads.values()][0]).toEqual({
      status: "ended",
      metadata: { label: "create", actions: { create: 2, delete: 1 } },
    });
    expect(events).toContainEqual(["manager_thread_ended", {}]);
  });

  it("does not count a denied or failed change", async () => {
    const { api, threads } = server();
    const script = [propose(CREATE(1)), propose(CREATE(2)), "Okay."];
    let n = 0;
    const { chat } = await manager(fake(() => script[n++]!).runAgent, {
      threads: api,
      runCommand: async () => ({ code: 1, output: "boom" }),
    });
    await chat.send("make a bot").done;
    await chat.answer(false).done;
    await chat.answer(true).done;
    await chat.close();
    expect([...threads.values()][0]!.metadata).toEqual({ label: "generic", actions: {} });
  });

  it("closes once, and not at all for a chat that never started", async () => {
    const { api, calls } = server();
    const unused = await manager(fake(() => "").runAgent, { threads: api });
    await unused.chat.close();
    expect(calls).toEqual([]);

    const { chat } = await manager(fake(() => "Hi.").runAgent, { threads: api });
    await chat.send("hello").done;
    await chat.close();
    await chat.close();
    expect(calls).toEqual(["create", "patch", "patch"]);
  });

  it("keeps chatting when the thread can't be made, and tries again on the next message", async () => {
    const { api, threads } = server(1);
    const { runs, runAgent } = fake(() => "Hi.");
    const { chat, events } = await manager(runAgent, { threads: api });
    await chat.send("one").done;
    expect((await chat.read()).messages.at(-1)!.text).toBe("Hi.");
    expect(runs[0]!.mcpTools).toBeUndefined();
    expect(threads.size).toBe(0);
    expect(events).toContainEqual(["manager_thread_failed", { step: "create", reason: "runner_not_leased" }]);

    await chat.send("two").done;
    expect(threads.size).toBe(1);
    expect(runs[1]!.mcpTools).toEqual(["record", "unrecord"]);
  });

  it("reports a refused label or end, and carries on", async () => {
    const { api } = server();
    const failing: ChatThreads = { ...api, patch: () => Promise.reject(new ApiError(409, "runner_not_leased", "no")) };
    const { chat, events } = await manager(fake(() => "Hi.").runAgent, { threads: failing });
    await chat.send("hello").done;
    await chat.close();
    expect(events).toContainEqual(["manager_thread_failed", { step: "label", reason: "runner_not_leased" }]);
    expect(events).toContainEqual(["manager_thread_failed", { step: "end", reason: "runner_not_leased" }]);
  });
});

describe("reservedChatKey", () => {
  it("finds the runner's keys when the manager sets or removes them, and only those", () => {
    expect(reservedChatKey({ metadata_set: { label: "x" } })).toBe("label");
    expect(reservedChatKey({ metadata_set: { note: 1, actions: {} } })).toBe("actions");
    expect(reservedChatKey({ metadata_unset: ["label"] })).toBe("label");
    expect(reservedChatKey({ metadata_set: { note: 1 }, metadata_unset: ["other"] })).toBeUndefined();
  });
});
