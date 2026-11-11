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
    expect(screen()).toContain("▸ dev      open   no session yet  1 pending 2026-11-10 14:05 o/r#12");
    expect(screen()).toContain("  review   open   running         0 pending 2026-11-10 14:30 o/r#13");
  });

  it("shows the latest poller line at the bottom", () => {
    show([dev12()]);
    expect(screen().trim().split("\n").at(-3)).toBe("14:03 update o/r#12 comment by me");
  });

  it("shows the poller's status line, so a quiet repo does not look stuck", () => {
    show([]);
    expect(screen().trim().split("\n").at(-2)).toBe("polling o/r · last checked 14:02 · next in 0:24");
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
    expect(screen()).toContain("▸ dev      open   no session yet  0 pending 2026-11-10 14:00 o/r#1");
    await press(KEYS.up);
    expect(screen()).toContain("▸ dev      open   no session yet  0 pending 2026-11-10 14:00 o/r#1");
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

  it("opens with enter and shows subjects, session, pending updates and sent messages", async () => {
    show([full()]);
    await press(KEYS.enter);
    const frame = screen();
    expect(frame).toContain("dev t1 · open");
    expect(frame).toContain("session blocked · last run 2026-11-10 14:08 · needs a decision");
    expect(frame).toContain("▸ o/r#12 open");
    expect(frame).toContain("  o/r#13 open");
    expect(frame).toContain("Pending (2)");
    expect(frame).toContain("2026-11-10 14:05 comment o/r#12 by ann");
    expect(frame).toContain("2026-11-10 14:06 labeled o/r#13 by bob");
    expect(frame).toContain("Sent (1)");
    expect(frame).toContain("2026-11-10 14:10 comment o/r#12 https://github.com/o/r/1");
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
    expect(frame).toContain("Waiting on (1)");
    expect(frame).toContain("2026-11-10 14:09 permission https://github.com/o/r/issues/12#issuecomment-5 Bash curl");
    expect(frame).toContain("https://github.com/o/r/issues/12#issuecomment-5");
    expect(frame).not.toContain("Which?");
  });

  it("says which subjects the thread created", async () => {
    const made = full();
    made.subjects[1]!.created = true;
    show([made]);
    await press(KEYS.enter);
    expect(screen()).toContain("▸ o/r#12 open\n");
    expect(screen()).toContain("o/r#13 open · created by this thread");
  });

  it("opens with the right arrow, and goes back with the left arrow or escape", async () => {
    show([full()]);
    await press(KEYS.right);
    expect(screen()).toContain("Subjects");
    await press(KEYS.left);
    expect(screen()).toContain("loopway · 1 threads");
    await press(KEYS.enter);
    await press(KEYS.esc);
    expect(screen()).toContain("loopway · 1 threads");
  });

  it("says there is no session yet when the thread has none, and no log", async () => {
    show([dev12()]);
    await press(KEYS.enter);
    expect(screen()).toContain("session no session yet");
    expect(screen()).toContain("no log yet");
    expect(screen()).toContain("Sent (0)");
  });

  it("follows the session log, and stops following when you scroll up", async () => {
    let log = lines(100);
    show([dev12()], { readLog: () => log });
    await press(KEYS.enter);
    expect(screen()).toContain("line 100");
    expect(screen()).not.toContain("line 1\n");
    await press("\u001B[5~"); // page up
    const scrolled = screen();
    expect(scrolled).toContain("scrolled");
    expect(scrolled).not.toContain("line 100");
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
    await press(KEYS.down); // the second subject of the review thread: o/r#12
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
    await press(KEYS.down);
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

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`)
    .join("\n")
    .concat("\n");
