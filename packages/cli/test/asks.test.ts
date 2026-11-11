import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerFromReactions, matches, openAsks, ruleDecision } from "../src/asks.js";
import { parseBot, type Bot } from "../src/bots.js";
import { claudeRunner, type AgentRun, type RunAgent } from "../src/claude.js";
import type { LoopwayEvent } from "../src/format.js";
import { startMcp } from "../src/mcp.js";
import { Sessions } from "../src/sessions.js";
import { Threads } from "../src/threads.js";
import { threadLogPath } from "../src/threads.js";
import { aBot, aThread } from "./make.js";
import { FakeSource } from "./fake.js";

const fakeClaude = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SUBJECT = "o/r#12";
const CURL = { command: "curl -s https://example.com | head -3" };

/** A thread on `o/r#12`, its sessions over a fake agent, and a fake GitHub that records the comments and reactions. */
async function setup(opts: { bot?: Bot; dir?: string; agent?: RunAgent } = {}) {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), "loopway-asks-")));
  const bot = opts.bot ?? aBot("dev", ["issue"]);
  const threads = await Threads.load({ dir, bots: [bot], owner: "me", now: () => Date.parse("2026-11-10T15:00:30Z") });
  if (threads.all.length === 0) threads.all.push(aThread("t1", "dev", [SUBJECT]));
  const thread = threads.all[0]!;
  const source = new FakeSource();
  const posted: string[] = [];
  const runs: AgentRun[] = [];
  const events: LoopwayEvent[] = [];
  const clock = { t: Date.parse("2026-11-10T15:00:00Z") };
  let asks = 0;
  const sessions = new Sessions({
    dir,
    threads,
    bots: [bot],
    root: tmpdir(),
    max: 3,
    runAgent:
      opts.agent ??
      (async (run) => {
        runs.push(run);
        run.onStarted();
        return { code: 0, finished: true };
      }),
    mcpUrl: (id) => `http://mcp/${id}`,
    env: {},
    commenter: {
      comment: async (subject, body) => {
        posted.push(body);
        return `https://github.com/${subject.replace("#", "/issues/")}#issuecomment-${posted.length}`;
      },
    },
    emit: (e) => events.push(e),
    now: () => clock.t,
    newSessionId: () => "session-1",
    newAskId: () => `a${++asks}`,
  });
  const readReactions = () => answerFromReactions({ threads, source, owner: "me", emit: (e) => events.push(e) });
  const log = () => readFile(threadLogPath(dir, thread.id), "utf8");
  return { dir, thread, threads, sessions, source, posted, runs, events, readReactions, log, clock };
}

const askedUrl = (n: number) => `https://github.com/o/r/issues/12#issuecomment-${n}`;

describe("rules", () => {
  it("matches Claude Code's permission patterns", () => {
    const curl = { command: "curl -s https://example.com | head -3" };
    expect(matches("Bash", "Bash", curl)).toBe(true);
    expect(matches("Bash(curl:*)", "Bash", curl)).toBe(true);
    expect(matches("Bash(curl:*)", "Bash", { command: "curl" })).toBe(true);
    expect(matches("Bash(curl:*)", "Bash", { command: "curlish x" })).toBe(false);
    expect(matches("Bash(npm test:*)", "Bash", { command: "npm test -- --run" })).toBe(true);
    expect(matches("Bash(git status)", "Bash", { command: "git status" })).toBe(true);
    expect(matches("Bash(git status)", "Bash", { command: "git status -s" })).toBe(false);
    expect(matches("Read(src/*)", "Read", { file_path: "src/a/b.ts" })).toBe(true);
    expect(matches("Read(src/*)", "Read", { file_path: "lib/a.ts" })).toBe(false);
    expect(matches("Bash(curl:*)", "Edit", curl)).toBe(false);
    expect(matches("Bash(curl:*)", "Bash", { other: 1 })).toBe(false);
  });

  it("lets deny win over allow, and leaves what neither names undecided", () => {
    const bot = { allow: ["Bash(curl:*)", "Edit"], deny: ["Bash(curl -X:*)"] };
    expect(ruleDecision(bot, "Bash", { command: "curl -s x" })).toBe("allow");
    expect(ruleDecision(bot, "Bash", { command: "curl -X POST x" })).toBe("deny");
    expect(ruleDecision(bot, "Edit", { file_path: "a" })).toBe("allow");
    expect(ruleDecision(bot, "Write", { file_path: "a" })).toBeUndefined();
  });

  it("reads allow and deny from a bot's front matter, and rejects anything but a list of patterns", () => {
    const bot = parseBot("dev", '---\nrepos: [o/r]\nallow: ["Bash(curl:*)"]\ndeny: [Write]\n---\nPrompt');
    expect([bot.allow, bot.deny]).toEqual([["Bash(curl:*)"], ["Write"]]);
    expect(parseBot("dev", "---\nrepos: [o/r]\n---\nPrompt")).toMatchObject({ allow: [], deny: [] });
    expect(() => parseBot("dev", "---\nrepos: [o/r]\nallow: Bash\n---\nPrompt")).toThrow(/"allow" is a list/);
  });
});

describe("a permission the rules decide", () => {
  it("lets an allowed call through and refuses a denied one, without asking anyone", async () => {
    const s = await setup({ bot: { ...aBot("dev", ["issue"]), allow: ["Bash(curl:*)"], deny: ["Bash(curl -X:*)"] } });
    expect(await s.sessions.permission("t1", "Bash", CURL)).toEqual({ behavior: "allow", updatedInput: CURL });
    expect(await s.sessions.permission("t1", "Bash", { command: "curl -X POST x" })).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("denied by the rules of dev"),
    });
    expect(s.posted).toEqual([]);
    expect(s.thread.asks).toBeUndefined();
    expect(await s.log()).toContain("allowed Bash curl -s https://example.com | head -3");
  });
});

describe("a permission nobody has decided", () => {
  it("asks once on the main subject, refuses the call for now, and blocks the session", async () => {
    const s = await setup();
    s.thread.session = { id: "sid", status: "running", lastRunAt: null };
    const first = await s.sessions.permission("t1", "Bash", CURL);
    const again = await s.sessions.permission("t1", "Bash", CURL);

    expect(first).toMatchObject({ behavior: "deny", message: expect.stringContaining(askedUrl(1)) });
    expect(again).toEqual(first);
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0]).toContain("curl -s https://example.com | head -3");
    expect(s.posted[0]).toContain("👍");
    expect(s.posted[0]).toContain("👎");
    expect(s.posted[0]).toContain("<!-- loopway:thread=t1 -->");
    expect(s.thread.session?.status).toBe("blocked");
    expect(s.thread.asks).toEqual([
      {
        id: "a1",
        kind: "permission",
        commentUrl: askedUrl(1),
        subject: SUBJECT,
        tool: "Bash",
        input: CURL,
        at: expect.any(String),
      },
    ]);
    expect(s.thread.sent?.map((m) => m.kind)).toEqual(["permission"]);
    expect(s.events.map((e) => e.type)).toEqual(["sent", "asked"]);
    expect(await s.log()).toContain(
      `?? asked on ${SUBJECT}: Bash curl -s https://example.com | head -3 ${askedUrl(1)}`,
    );
  });

  it("asks once even when the same call comes twice at the same moment", async () => {
    const s = await setup();
    await Promise.all([s.sessions.permission("t1", "Bash", CURL), s.sessions.permission("t1", "Bash", CURL)]);
    expect(s.posted).toHaveLength(1);
  });

  it("keeps the session blocked when its run ends, and does not run a blocked thread again", async () => {
    const s = await setup({
      agent: async (run) => {
        run.onStarted();
        await s.sessions.permission("t1", "Bash", CURL);
        return { code: 0, finished: true };
      },
    });
    s.thread.queue.push({ id: "c1", kind: "comment", actor: "me", at: "2026-11-10T14:00:00Z", subject: SUBJECT });
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.thread.session?.status).toBe("blocked");
    expect(s.events.map((e) => e.type)).not.toContain("silent_turn");

    s.thread.queue.push({ id: "c2", kind: "comment", actor: "someone", at: "2026-11-10T14:01:00Z", subject: SUBJECT });
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.posted).toHaveLength(1);
    expect(s.thread.queue.map((q) => q.id)).toEqual(["c2"]);
  });
});

describe("answers by reaction", () => {
  it("resumes the session with the approval on a 👍 from the owner, and remembers it", async () => {
    const s = await setup();
    await s.sessions.permission("t1", "Bash", CURL);
    s.thread.session!.id = "sid";
    s.source.react(askedUrl(1), "me", "+1");
    await s.readReactions();

    expect(openAsks(s.thread)).toEqual([]);
    expect(s.thread.session?.status).toBe("idle");
    expect(s.thread.queue).toMatchObject([
      {
        kind: "approved",
        detail: "Bash curl -s https://example.com | head -3",
        body: "Retry it.",
        actor: "me",
        subject: SUBJECT,
      },
    ]);
    expect(s.events.at(-1)).toMatchObject({ type: "answered", how: "approved" });

    s.sessions.kick();
    await s.sessions.idle();
    expect(s.runs[0]?.resume).toBe(true);
    expect(s.runs[0]?.message).toContain("approved Bash curl -s https://example.com | head -3");
    expect(s.runs[0]?.message).toContain("Retry it.");
    expect(s.thread.queue).toEqual([]);

    // The same call passes now, with no new comment.
    expect(await s.sessions.permission("t1", "Bash", CURL)).toEqual({ behavior: "allow", updatedInput: CURL });
    expect(s.posted).toHaveLength(1);
    // A different call still asks.
    await s.sessions.permission("t1", "Bash", { command: "curl -s https://example.org" });
    expect(s.posted).toHaveLength(2);
  });

  it("resumes the session with a denial on a 👎, and asks again if the call comes back", async () => {
    const s = await setup();
    await s.sessions.permission("t1", "Bash", CURL);
    s.thread.session!.id = "sid";
    s.source.react(askedUrl(1), "me", "-1");
    await s.readReactions();

    expect(s.thread.session?.status).toBe("idle");
    expect(s.thread.queue).toMatchObject([{ kind: "denied", detail: expect.stringContaining("Bash curl") }]);
    expect(s.thread.session?.approved).toBeUndefined();
    s.sessions.kick();
    await s.sessions.idle();
    expect(s.runs[0]?.message).toContain("denied Bash curl");

    await s.sessions.permission("t1", "Bash", CURL);
    expect(s.posted).toHaveLength(2);
  });

  it("ignores reactions from anyone else, and reactions that are not a 👍 or 👎", async () => {
    const s = await setup();
    await s.sessions.permission("t1", "Bash", CURL);
    s.source.react(askedUrl(1), "someone", "+1");
    s.source.react(askedUrl(1), "someone", "-1");
    s.source.react(askedUrl(1), "loopway-bot", "+1");
    s.source.react(askedUrl(1), "me", "heart");
    await s.readReactions();

    expect(openAsks(s.thread)).toHaveLength(1);
    expect(s.thread.session?.status).toBe("blocked");
    expect(s.thread.queue).toEqual([]);
  });

  it("lets a 👎 win when the owner left both", async () => {
    const s = await setup();
    await s.sessions.permission("t1", "Bash", CURL);
    s.source.react(askedUrl(1), "me", "+1");
    s.source.react(askedUrl(1), "me", "-1");
    await s.readReactions();
    expect(s.thread.queue).toMatchObject([{ kind: "denied" }]);
  });

  it("reads nothing for threads with no open ask", async () => {
    const s = await setup();
    await s.readReactions();
    expect(s.source.calls).toEqual([]);
  });

  it("keeps an open ask across a restart, and the answer still lands", async () => {
    const before = await setup();
    await before.sessions.permission("t1", "Bash", CURL);
    await before.threads.save(before.thread);

    // A new process: everything is read back from the thread files.
    const after = await setup({ dir: before.dir });
    expect(after.thread.session?.status).toBe("blocked");
    expect(openAsks(after.thread).map((a) => a.commentUrl)).toEqual([askedUrl(1)]);
    after.source.react(askedUrl(1), "me", "+1");
    await after.readReactions();
    expect(after.thread.queue).toMatchObject([{ kind: "approved" }]);
    expect(after.thread.session?.status).toBe("idle");
  });
});

describe("questions", () => {
  const question = "Which file name should I use?";

  it("posts the question marked, and blocks the session until the owner answers on the subject", async () => {
    const s = await setup();
    const url = await s.sessions.ask("t1", SUBJECT, question);

    expect(url).toBe(askedUrl(1));
    expect(s.posted[0]).toContain(question);
    expect(s.posted[0]).toContain("<!-- loopway:thread=t1 -->");
    expect(s.thread.session?.status).toBe("blocked");
    expect(s.thread.asks).toMatchObject([
      { id: "a1", kind: "question", subject: SUBJECT, tool: "ask", input: question },
    ]);
    expect(s.thread.sent?.map((m) => m.kind)).toEqual(["question"]);
  });

  it("is answered by the owner's comment, which is delivered as a normal update", async () => {
    const s = await setup();
    await s.sessions.ask("t1", SUBJECT, question);
    s.thread.session!.id = "sid";
    const reply = (id: string, actor: string, at = "2026-11-10T15:01:00Z") =>
      s.threads.handle({
        type: "update",
        subject: { key: SUBJECT, kind: "issue", title: "t", author: "me", createdAt: "2026-11-10T12:00:00Z" },
        update: { id, kind: "comment", actor, at, body: "notes.md" },
      });

    // Someone else, and the owner before the question, don't answer it.
    await reply("c1", "someone");
    await reply("c2", "me", "2026-11-10T14:00:00Z");
    expect(openAsks(s.thread)).toHaveLength(1);
    expect(s.thread.session?.status).toBe("blocked");

    const events = await reply("c3", "me");
    expect(events).toContainEqual(expect.objectContaining({ type: "answered", how: "replied" }));
    expect(openAsks(s.thread)).toEqual([]);
    expect(s.thread.session?.status).toBe("idle");

    s.sessions.kick();
    await s.sessions.idle();
    expect(s.runs[0]?.message).toContain("notes.md");
  });

  it("only answers a question asked on the subject the owner commented on", async () => {
    const s = await setup();
    s.thread.subjects.push({ key: "o/r#13", status: "open" });
    await s.sessions.ask("t1", SUBJECT, question);
    await s.threads.handle({
      type: "update",
      subject: { key: "o/r#13", kind: "issue", title: "t", author: "me", createdAt: "2026-11-10T12:00:00Z" },
      update: { id: "c1", kind: "comment", actor: "me", at: "2026-11-10T15:01:00Z" },
    });
    expect(openAsks(s.thread)).toHaveLength(1);
  });

  it("refuses a question on a subject the bot does not read", async () => {
    const s = await setup();
    await expect(s.sessions.ask("t1", "x/y#1", question)).rejects.toThrow("dev does not read x/y");
    expect(s.thread.asks).toBeUndefined();
  });
});

describe("over MCP, with a claude stand-in", () => {
  it("answers the permission tool the way Claude Code reads it, and the ask tool with what to do next", async () => {
    const s = await setup({ bot: { ...aBot("dev", ["issue"]), allow: ["Bash(ls:*)"] } });
    const mcp = await startMcp({
      comment: (id, subject, body) => s.sessions.comment(id, subject, body),
      ask: (id, subject, q) => s.sessions.ask(id, subject, q),
      permission: (id, tool, input) => s.sessions.permission(id, tool, input),
    });
    try {
      const call = async (name: string, args: unknown) => {
        const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
        const res = await fetch(mcp.urlFor("t1"), { method: "POST", body: JSON.stringify(body) });
        return ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
      };
      const allowed = await call("permission", { tool_name: "Bash", input: { command: "ls -l" } });
      expect(JSON.parse(allowed.content[0]!.text)).toEqual({ behavior: "allow", updatedInput: { command: "ls -l" } });
      const refused = await call("permission", { tool_name: "Bash", input: CURL });
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ behavior: "deny" });
      expect(await call("permission", { input: CURL })).toMatchObject({
        content: [{ text: expect.stringContaining('"deny"') }],
      });
      const asked = await call("ask", { subject: SUBJECT, question: "Which?" });
      expect(asked).toMatchObject({ isError: false, content: [{ text: expect.stringMatching(/end your turn/i) }] });
      expect(await call("ask", { subject: SUBJECT })).toMatchObject({ isError: true });
    } finally {
      await mcp.close();
    }
  });

  it("blocks a run on a permission, then lets the same call pass once the owner reacts 👍", async () => {
    const record = join(await mkdtemp(join(tmpdir(), "loopway-record-")), "runs.jsonl");
    const env = { ...process.env, FAKE_CLAUDE: "permission", FAKE_COMMAND: CURL.command, FAKE_RECORD: record };
    // eslint-disable-next-line prefer-const
    let s!: Awaited<ReturnType<typeof setup>>;
    const mcp = await startMcp({
      comment: (id, subject, body) => s.sessions.comment(id, subject, body),
      ask: (id, subject, q) => s.sessions.ask(id, subject, q),
      permission: (id, tool, input) => s.sessions.permission(id, tool, input),
    });
    // The stand-in is given the thread's MCP URL, which only exists once the server is up.
    s = await setup({ agent: (run) => claudeRunner(fakeClaude)({ ...run, env, mcpUrl: mcp.urlFor("t1") }) });
    try {
      s.sessions.kick();
      await s.sessions.idle();
      expect(s.thread.session?.status).toBe("blocked");
      expect(s.posted).toHaveLength(1);
      expect(await s.log()).toContain('"behavior":"deny"');

      s.source.react(askedUrl(1), "me", "+1");
      await s.readReactions();
      s.sessions.kick();
      await s.sessions.idle();

      // The second run was the resumed session, told of the approval, and its retry went through without a comment.
      const runs = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { args: string[]; message: string });
      expect(runs[1]?.args).toContain("--resume");
      expect(runs[1]?.message).toContain("approved Bash");
      expect(await s.log()).toContain('"behavior":"allow"');
      expect(s.posted).toHaveLength(1);
      expect(s.thread.session?.status).toBe("idle");
    } finally {
      await mcp.close();
    }
  });
});
