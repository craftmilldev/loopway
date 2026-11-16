import { render } from "ink-testing-library";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../src/thread.js";
import { CLOSED_SHOWN_MS } from "../src/threads.js";
import { formatPollStatus } from "../src/tui-text.js";
import { Tui, type TuiProps } from "../src/tui.js";
import { harness } from "./fake.js";
import { aThread, anUpdate } from "./make.js";

const KEYS = { up: "\u001B[A", down: "\u001B[B", right: "\u001B[C", left: "\u001B[D", enter: "\r", esc: "\u001B" };
const NOW = Date.parse("2026-11-10T15:00:00Z");

let mounted: ReturnType<typeof render> | undefined;
afterEach(() => mounted?.unmount());

/** Types a key and lets the screen catch up. */
async function press(key: string) {
  mounted!.stdin.write(key);
  await sleep(20);
}

/** What's on screen, without colors. */
const screen = () => plain(mounted!.lastFrame() ?? "");

function show(threads: Thread[] | (() => Thread[]), more: Partial<TuiProps> = {}) {
  mounted = render(
    <Tui
      threads={typeof threads === "function" ? threads : () => threads}
      version="2.0.1"
      readLog={() => ""}
      latest={() => "14:03 update o/r#12 comment by me"}
      status={() => "polling o/r · last checked 14:02 · next in 0:24"}
      onRefresh={() => {}}
      now={() => NOW}
      refreshMs={10}
      {...more}
    />,
  );
}

const when = (iso: string): Partial<Thread> => ({ latestAt: iso });
const dev12 = () => ({ ...aThread("t1", "dev", ["o/r#12"]), ...when("2026-11-10T14:05:00Z") });
const review13 = () => ({ ...aThread("t2", "review", ["o/r#13"]), ...when("2026-11-10T14:30:00Z") });

describe("main view", () => {
  it("shows a row per thread: bot, status, session, pending, time of the latest message, subjects", () => {
    const withQueue = { ...dev12(), queue: [{ ...anUpdate("c1"), subject: "o/r#12" }] };
    const running = { ...review13(), session: { id: "s1", status: "running" as const, lastRunAt: null } };
    show([withQueue, running]);
    expect(screen()).toContain("▸ review   running         0 pending 2026-11-10 14:30 o/r#13");
    expect(screen()).toContain("  dev      no session yet  1 pending 2026-11-10 14:05 o/r#12");
  });

  it("always shows loopway's version, with the poller's status a row below it", () => {
    show([dev12()]);
    const [title, status] = screen().split("\n");
    expect(title).toContain("loopway  v2.0.1");
    expect(status).toContain("polling o/r · last checked 14:02 · next in 0:24");
  });

  it("groups the open threads by state, what needs you first, and the closed ones last", () => {
    const blocked = {
      ...aThread("b", "dev", ["o/r#1"]),
      session: { id: "s", status: "blocked" as const, lastRunAt: null },
    };
    const running = {
      ...aThread("r", "dev", ["o/r#2"]),
      session: { id: "s", status: "running" as const, lastRunAt: null },
    };
    const failed = {
      ...aThread("f", "dev", ["o/r#3"]),
      session: { id: "s", status: "failed" as const, lastRunAt: null },
    };
    const queued = { ...aThread("q", "dev", ["o/r#4"]), queue: [{ ...anUpdate("c1"), subject: "o/r#4" }] };
    const quiet = aThread("i", "dev", ["o/r#5"]);
    const closed = { ...aThread("c", "dev", ["o/r#6"], "closed"), ...when("2026-11-10T14:00:00Z") };
    show([closed, quiet, queued, failed, running, blocked]);
    const headings = screen()
      .split("\n")
      .filter((l) => /^(Open|Closed)/.test(l))
      .map((l) => l.replace(/ \d+\s*$/, ""));
    expect(headings).toEqual([
      "Open · needs you",
      "Open · running",
      "Open · failed",
      "Open · updates waiting",
      "Open · quiet",
      "Closed",
    ]);
    const subjects = screen()
      .split("\n")
      .filter((l) => l.includes(" pending "))
      .map((l) => l.match(/o\/r#\d/)![0]);
    expect(subjects).toEqual(["o/r#1", "o/r#2", "o/r#3", "o/r#4", "o/r#5", "o/r#6"]);
  });

  it("moves through the rows in the order shown, not the order the threads came in", async () => {
    const running = {
      ...aThread("r", "dev", ["o/r#2"]),
      session: { id: "s", status: "running" as const, lastRunAt: null },
    };
    show([aThread("i", "dev", ["o/r#5"]), running]);
    expect(screen()).toContain("▸ dev      running");
    await press(KEYS.down);
    expect(screen()).toContain("▸ dev      no session yet");
  });

  it("pins the keys to the bottom of the screen, under the poller's latest line", () => {
    show([dev12()]);
    const lines = screen().trimEnd().split("\n");
    expect(lines.at(-1)).toContain("↑/↓ move");
    expect(lines.at(-2)).toBe("14:03 update o/r#12 comment by me");
    expect(lines.at(-1)).not.toContain("pgup");
  });

  it("shows the latest poller line at the bottom", () => {
    show([dev12()]);
    expect(screen()).toContain("14:03 update o/r#12 comment by me");
  });

  it("shows the poller's status line, so a quiet repo does not look stuck", () => {
    show([]);
    expect(screen().split("\n")[1]).toBe("polling o/r · last checked 14:02 · next in 0:24");
    expect(screen()).not.toContain("waiting for the poller");
  });

  it("says so when there are no threads", () => {
    show([]);
    expect(screen()).toContain("No threads yet.");
  });

  it("moves the selection with up and down, and keeps it on the same thread as the list changes", async () => {
    let threads = [dev12(), review13()];
    show(() => threads);
    await press(KEYS.down);
    expect(screen()).toContain("▸ review");
    threads = [{ ...aThread("t0", "dev", ["o/r#1"]), ...when("2026-11-10T14:00:00Z") }, ...threads];
    await sleep(30);
    expect(screen()).toContain("▸ review");
    await press(KEYS.up);
    await press(KEYS.up);
    expect(screen()).toContain("▸ dev      no session yet  0 pending 2026-11-10 14:00 o/r#1");
    await press(KEYS.up);
    expect(screen()).toContain("▸ dev      no session yet  0 pending 2026-11-10 14:00 o/r#1");
  });

  it("shows new threads and changes as the store changes", async () => {
    const threads = [dev12()];
    show(() => threads);
    threads.push(review13());
    await sleep(30);
    expect(screen()).toContain("review");
  });
});

describe("refresh", () => {
  it("shows r refresh in the footer", () => {
    show([dev12()]);
    expect(screen()).toContain("r refresh");
  });

  it("r runs one discovery and one update pass, and a second r while it runs does nothing", async () => {
    const h = harness();
    h.state.subjects["o/r#12"] = {
      subject: { key: "o/r#12", kind: "issue", title: "t", author: "me", createdAt: "2026-11-10T11:00:00Z" },
      seen: [],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const discover = h.source.discover.bind(h.source);
    h.source.discover = async (repo, since) => (await gate, discover(repo, since));
    show([dev12()], {
      onRefresh: () => void h.poller.refresh(),
      status: (now) => formatPollStatus(["o/r"], h.poller.status(), now),
    });

    await press("r");
    await press("r");
    expect(screen()).toContain("refreshing…");
    release();
    await sleep(20);
    await press("r");
    expect(h.source.calls).toEqual(["discover o/r", "updates o/r#12", "discover o/r", "updates o/r#12"]);
  });
});

describe("closed threads", () => {
  const closed = (id: string, latestAt: string) => ({
    ...aThread(id, "dev", [`o/r#${id}`], "closed"),
    ...when(latestAt),
  });
  const within = new Date(NOW - CLOSED_SHOWN_MS + 60_000).toISOString();
  const outside = new Date(NOW - CLOSED_SHOWN_MS - 60_000).toISOString();

  it("lists those closed in the last 3 days, judged by their latest message, after the open ones", () => {
    // Created long ago, but it had a message within the window.
    const recent = { ...closed("recent", within), createdAt: "2026-10-01T00:00:00Z" };
    show([closed("old", outside), recent, dev12()]);
    const rows = screen()
      .split("\n")
      .filter((l) => l.includes(" pending "));
    expect(rows.map((r) => r.match(/o\/r#\w+/)![0])).toEqual(["o/r#12", "o/r#recent"]);
  });

  it("dims them", () => {
    show([closed("recent", within), dev12()]);
    const frame = mounted!.lastFrame()!;
    const row = (subject: string) => frame.split("\n").find((l) => l.includes(subject))!;
    expect(row("o/r#recent")).toContain("\u001B[2m");
    expect(row("o/r#12")).not.toContain("\u001B[2m");
  });
});

describe("thread view", () => {
  const sent = [{ at: "2026-11-10T14:10:00Z", subject: "o/r#12", kind: "comment", url: "https://github.com/o/r/1" }];
  const full = (): Thread => ({
    ...aThread("t1", "dev", ["o/r#12", "o/r#13"]),
    queue: [
      { ...anUpdate("c1", "comment", "2026-11-10T14:05:00Z"), actor: "ann", subject: "o/r#12" },
      { ...anUpdate("c2", "labeled", "2026-11-10T14:06:00Z"), actor: "bob", subject: "o/r#13" },
    ],
    session: { id: "s1", status: "blocked", lastRunAt: "2026-11-10T14:08:00Z", lastError: "needs a decision" },
    sent,
  });

  it("opens with enter and shows the version, the session, the subjects, and the queue and sent messages as counts", async () => {
    show([full()]);
    await press(KEYS.enter);
    const frame = screen();
    expect(frame).toContain("loopway  v2.0.1");
    expect(frame).toContain("dev t1 · open");
    expect(frame).toContain("session ● blocked · needs a decision · last run 2026-11-10 14:08");
    expect(frame).toContain("▸ o/r#12 open");
    expect(frame).toContain("  o/r#13 open");
    expect(frame).toContain(" 2  subjects");
    expect(frame).toContain(" 2  updates queued");
    expect(frame).toContain(" 1  messages sent");
    expect(frame).not.toContain("by ann"); // the messages themselves are not listed
    expect(frame).not.toContain("https://github.com/o/r/1");
  });

  it("shows what the thread is waiting on, with the links, and a blocked session on the main view", async () => {
    const waiting = {
      ...full(),
      asks: [
        {
          id: "a1",
          kind: "permission" as const,
          commentUrl: "https://github.com/o/r/issues/12#issuecomment-5",
          subject: "o/r#12",
          tool: "Bash",
          input: { command: "curl -s https://example.com" },
          at: "2026-11-10T14:09:00Z",
        },
        {
          id: "a0",
          kind: "question" as const,
          commentUrl: "u0",
          subject: "o/r#12",
          tool: "ask",
          input: "Which?",
          at: "2026-11-10T14:00:00Z",
          answeredAt: "2026-11-10T14:01:00Z",
        },
      ],
    };
    show([waiting]);
    expect(screen()).toContain("blocked");
    await press(KEYS.enter);
    const frame = screen();
    expect(frame).toContain("Waiting on you (1)");
    expect(frame).toContain(" 1  waiting on you");
    expect(frame).toContain("2026-11-10 14:09 permission https://github.com/o/r/issues/12#issuecomment-5 Bash curl");
    expect(frame).toContain("https://github.com/o/r/issues/12#issuecomment-5");
    expect(frame).not.toContain("Which?");
  });

  it("says which subjects the thread created", async () => {
    const made = full();
    made.subjects[1]!.created = true;
    show([made]);
    await press(KEYS.enter);
    expect(screen()).toContain("▸ o/r#12 open");
    expect(screen()).toContain("o/r#13 open · created by this thread");
  });

  it("opens with the right arrow, and goes back with the left arrow or escape", async () => {
    show([full()]);
    await press(KEYS.right);
    expect(screen()).toContain("subjects");
    await press(KEYS.left);
    expect(screen()).toContain("1 threads");
    await press(KEYS.enter);
    await press(KEYS.esc);
    expect(screen()).toContain("1 threads");
  });

  it("says there is no session yet when the thread has none, and no log", async () => {
    show([dev12()]);
    await press(KEYS.enter);
    expect(screen()).toContain("session ● no session yet");
    expect(screen()).toContain("no log yet");
    expect(screen()).toContain(" 0  messages sent");
  });

  it("follows the session log, and stops following when you scroll up with the arrow keys", async () => {
    let log = lines(100);
    show([dev12()], { readLog: () => log });
    await press(KEYS.enter);
    expect(screen()).toContain("line 100");
    expect(screen()).not.toContain("line 1\n");
    await press(KEYS.up);
    const scrolled = screen();
    expect(scrolled).toContain("scrolled");
    expect(scrolled).not.toContain("line 100");
    expect(scrolled).toContain("line 99");
    await press(KEYS.down); // down to the end follows again
    expect(screen()).not.toContain("scrolled");
    expect(screen()).toContain("line 100");
    await press("\u001B[5~"); // page up still works
    expect(screen()).toContain("scrolled");
    log = lines(120);
    await sleep(30);
    expect(screen()).not.toContain("line 120");
    await press("\u001B[F"); // end
    expect(screen()).toContain("line 120");
  });
});

describe("subject filter", () => {
  const two = () => [
    { ...aThread("t1", "dev", ["o/r#12"]), ...when("2026-11-10T14:05:00Z") },
    { ...aThread("t2", "review", ["o/r#13", "o/r#12"]), ...when("2026-11-10T14:30:00Z") },
    { ...aThread("t3", "review", ["o/r#14"]), ...when("2026-11-10T14:40:00Z") },
  ];

  it("filters the main view to the threads holding the selected subject, shows it in the header, and esc clears it", async () => {
    show(two());
    await press(KEYS.down);
    await press(KEYS.enter);
    await press("\t"); // the second subject of the review thread: o/r#12
    await press(KEYS.enter);
    expect(screen()).toContain("filter o/r#12 (esc clears)");
    expect(screen()).toContain("dev ");
    expect(screen()).toContain("o/r#13,o/r#12");
    expect(screen()).not.toContain("o/r#14");
    await press(KEYS.esc);
    expect(screen()).not.toContain("filter o/r#12");
    expect(screen()).toContain("o/r#14");
  });

  it("shows both the dev thread and the review thread for a pull request a thread created", async () => {
    const dev = aThread("t1", "dev", ["o/r#12", "o/r#13"]);
    dev.subjects[1]!.created = true;
    show([dev, aThread("t2", "review", ["o/r#13"])]);
    await press(KEYS.enter);
    await press("\t");
    await press(KEYS.enter); // filter by o/r#13
    expect(screen()).toContain("filter o/r#13");
    expect(screen()).toContain("dev ");
    expect(screen()).toContain("review ");
  });

  it("still holds the filter when opening a thread from the filtered view", async () => {
    show(two());
    await press(KEYS.enter);
    await press(KEYS.enter); // filter by o/r#12
    await press(KEYS.enter);
    await press(KEYS.left);
    expect(screen()).toContain("filter o/r#12");
  });
});

describe("chat", () => {
  const typed = async (text: string) => {
    for (const ch of text) await press(ch);
  };
  function chatting() {
    const calls: string[] = [];
    show([dev12()], {
      chat: { send: (id, text) => calls.push(`send ${id} ${text}`), end: (id) => calls.push(`end ${id}`) },
    });
    return calls;
  }

  it("offers c in a thread's hint, and only when there are sessions", async () => {
    chatting();
    await press(KEYS.enter);
    expect(screen()).toContain("c chat");
    mounted!.unmount();
    show([dev12()]);
    await press(KEYS.enter);
    expect(screen()).not.toContain("c chat");
  });

  it("c opens an input line, Enter sends what was typed (q included), and Esc ends the chat", async () => {
    const calls = chatting();
    await press(KEYS.enter);
    await press("c");
    expect(screen()).toContain("chat ›");
    await typed("quick q");
    expect(screen()).toContain("chat › quick q");
    expect(screen()).not.toContain("pgup");
    await press(KEYS.enter);
    await press(KEYS.esc);
    expect(calls).toEqual(["send t1 quick q", "end t1"]);
    expect(screen()).not.toContain("chat ›");
    expect(screen()).toContain("dev t1"); // still in the thread view, not quit or back
  });

  it("backspace edits the line, and an empty line sends nothing", async () => {
    const calls = chatting();
    await press(KEYS.enter);
    await press("c");
    await press(KEYS.enter);
    await typed("abc");
    await press("\u007F");
    await press(KEYS.enter);
    await press(KEYS.esc);
    expect(calls).toEqual(["send t1 ab", "end t1"]);
  });

  it("moves the cursor with left and right, so text can be added in the middle", async () => {
    const calls = chatting();
    await press(KEYS.enter);
    await press("c");
    await typed("hello");
    await press(KEYS.left);
    await press(KEYS.left);
    await press(KEYS.left);
    await typed("XY");
    await press(KEYS.right);
    await typed("!");
    await press(KEYS.enter);
    await press(KEYS.esc);
    expect(calls).toEqual(["send t1 heXYl!lo", "end t1"]);
  });

  it("jumps to the ends with home and end, and Delete removes the character after the cursor", async () => {
    const calls = chatting();
    await press(KEYS.enter);
    await press("c");
    await typed("bcd");
    await press("\u001B[H"); // home
    await typed("a");
    await press("\u001B[3~"); // delete
    await press("\u001B[F"); // end
    await typed("e");
    await press(KEYS.enter);
    await press(KEYS.esc);
    expect(calls).toEqual(["send t1 acde", "end t1"]);
  });

  it("shows a cursor in the chat box and keeps the log in view, and the keys are for chatting", async () => {
    chatting();
    await press(KEYS.enter);
    await press("c");
    expect(screen()).toContain("←/→ move in the line");
    expect(screen()).not.toContain("pgup");
  });

  it("does not start a chat on a closed thread", async () => {
    chatting();
    mounted!.unmount();
    show([aThread("t1", "dev", ["o/r#12"], "closed")], { chat: { send: () => {}, end: () => {} } });
    await press(KEYS.enter);
    await press("c");
    expect(screen()).not.toContain("chat ›");
  });
});

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`)
    .join("\n")
    .concat("\n");
