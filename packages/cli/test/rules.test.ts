import { describe, expect, it } from "vitest";
import { decide } from "../src/rules.js";
import { markerOf } from "../src/thread.js";
import { aBot, aSubject, aThread, anUpdate, dev, review } from "./make.js";

const bots = [dev, review];

describe("a new subject", () => {
  it("starts a dev thread for an issue", () => {
    const issue = aSubject(1);
    expect(decide({ type: "new", subject: issue }, [], bots)).toEqual([
      { type: "open", bot: "dev", subject: issue, pending: [] },
    ]);
  });

  it("starts a review thread for a pull request", () => {
    const pr = aSubject(2, "pull_request");
    expect(decide({ type: "new", subject: pr }, [], bots)).toEqual([
      { type: "open", bot: "review", subject: pr, pending: [] },
    ]);
  });

  it("starts a thread for every bot that wants the kind", () => {
    const both = aBot("both", ["issue", "pull_request"]);
    const actions = decide({ type: "new", subject: aSubject(1) }, [], [dev, both]);
    expect(actions.map((a) => a.type === "open" && a.bot)).toEqual(["dev", "both"]);
  });

  it("ignores a bot that does not read the repo, or has no rules", () => {
    expect(decide({ type: "new", subject: aSubject(1, "issue", "x/y") }, [], bots)).toEqual([]);
    expect(decide({ type: "new", subject: aSubject(1) }, [], [aBot("quiet", [])])).toEqual([]);
  });

  it("does not start a second thread for a subject the bot already has one for", () => {
    expect(decide({ type: "new", subject: aSubject(1) }, [aThread("t1", "dev", ["o/r#1"])], bots)).toEqual([]);
  });
});

describe("an update", () => {
  const comment = anUpdate("comment:1");

  it("goes on the queue of every open thread holding the subject", () => {
    const threads = [
      aThread("t1", "dev", ["o/r#1"]),
      aThread("t2", "review", ["o/r#1"]),
      aThread("t3", "dev", ["o/r#2"]),
    ];
    const actions = decide({ type: "update", subject: aSubject(1), update: comment }, threads, bots);
    expect(actions).toEqual([
      { type: "queue", thread: "t1", subject: "o/r#1", update: comment },
      { type: "queue", thread: "t2", subject: "o/r#1", update: comment },
    ]);
  });

  it("is not given back to the thread that sent it, but is to every other thread holding the subject", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"]), aThread("t2", "review", ["o/r#1"])];
    const sent = { ...comment, actor: "loopway-bot", body: `Done.\n\n${markerOf("t1")}` };
    const actions = decide({ type: "update", subject: aSubject(1), update: sent }, threads, bots);
    expect(actions).toEqual([{ type: "queue", thread: "t2", subject: "o/r#1", update: sent }]);
  });

  it("is not given to a closed thread", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"], "closed")];
    expect(decide({ type: "update", subject: aSubject(1), update: comment }, threads, bots)).toEqual([]);
  });

  it("closes a thread when its only subject closes or merges", () => {
    const closed = anUpdate("event:1", "closed");
    const actions = decide(
      { type: "update", subject: aSubject(1), update: closed },
      [aThread("t1", "dev", ["o/r#1"])],
      bots,
    );
    expect(actions).toEqual([
      { type: "queue", thread: "t1", subject: "o/r#1", update: closed },
      { type: "mark", thread: "t1", subject: "o/r#1", status: "closed" },
      { type: "close", thread: "t1" },
    ]);
    const merged = anUpdate("event:2", "merged");
    const pr = aSubject(2, "pull_request");
    expect(
      decide({ type: "update", subject: pr, update: merged }, [aThread("t2", "review", [pr.key])], bots),
    ).toContainEqual({
      type: "close",
      thread: "t2",
    });
  });

  it("keeps a thread open while another of its subjects is open", () => {
    const threads = [aThread("t1", "dev", ["o/r#1", "o/r#2"])];
    const actions = decide({ type: "update", subject: aSubject(1), update: anUpdate("e", "closed") }, threads, bots);
    expect(actions.map((a) => a.type)).toEqual(["queue", "mark"]);
    // Once the other closes too, the thread closes.
    threads[0]!.subjects[0]!.status = "closed";
    const last = decide({ type: "update", subject: aSubject(2), update: anUpdate("f", "closed") }, threads, bots);
    expect(last.map((a) => a.type)).toEqual(["queue", "mark", "close"]);
  });

  it("reopening a subject on an open thread keeps it there, marked open again", () => {
    const threads = [aThread("t1", "dev", ["o/r#1", "o/r#2"])];
    threads[0]!.subjects[0]!.status = "closed";
    const reopened = anUpdate("event:3", "reopened");
    expect(decide({ type: "update", subject: aSubject(1), update: reopened }, threads, bots)).toEqual([
      { type: "queue", thread: "t1", subject: "o/r#1", update: reopened },
      { type: "mark", thread: "t1", subject: "o/r#1", status: "open" },
    ]);
  });

  it("reopening a subject after its thread closed starts a new thread, which never touches the old one", () => {
    const issue = aSubject(1);
    const reopened = anUpdate("event:3", "reopened");
    const actions = decide(
      { type: "update", subject: issue, update: reopened },
      [aThread("t1", "dev", [issue.key], "closed")],
      bots,
    );
    expect(actions).toEqual([{ type: "open", bot: "dev", subject: issue, pending: [reopened] }]);
  });

  it("gives a known pull request without a review thread one", () => {
    const pr = aSubject(2, "pull_request");
    const actions = decide({ type: "update", subject: pr, update: comment }, [], bots);
    expect(actions).toEqual([{ type: "open", bot: "review", subject: pr, pending: [] }]);
  });

  it("does not give a thread to a pull request whose review thread already closed with it", () => {
    const pr = aSubject(2, "pull_request");
    const threads = [aThread("t1", "review", [pr.key], "closed")];
    expect(decide({ type: "update", subject: pr, update: comment }, threads, bots)).toEqual([]);
  });

  it("does not start a thread for a subject that is closing", () => {
    const pr = aSubject(2, "pull_request");
    expect(decide({ type: "update", subject: pr, update: anUpdate("e", "closed") }, [], bots)).toEqual([]);
  });
});

describe("a subject a thread created", () => {
  const issue = { ...aSubject(5), author: "loopway-bot" };
  const pr = { ...aSubject(6, "pull_request"), author: "loopway-bot" };
  const creation = (subject: typeof issue) => ({
    id: `created:${subject.key}`,
    kind: "created",
    actor: "loopway-bot",
    at: subject.createdAt,
  });

  it("joins the thread that made it, and starts a dev thread for an issue, even for the dev bot that made it", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"])];
    expect(decide({ type: "created", thread: "t1", subject: issue, subscribe: true }, threads, bots)).toEqual([
      { type: "track", thread: "t1", subject: issue },
      { type: "open", bot: "dev", subject: issue, pending: [creation(issue)] },
    ]);
  });

  it("is not tracked by the thread that made it with subscribe: false, but still starts its threads", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"])];
    expect(decide({ type: "created", thread: "t1", subject: issue, subscribe: false }, threads, bots)).toEqual([
      { type: "open", bot: "dev", subject: issue, pending: [creation(issue)] },
    ]);
  });

  it("joins the thread that made it, and starts a review thread for a pull request", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"])];
    expect(decide({ type: "created", thread: "t1", subject: pr, subscribe: true }, threads, bots)).toEqual([
      { type: "track", thread: "t1", subject: pr },
      { type: "open", bot: "review", subject: pr, pending: [creation(pr)] },
    ]);
  });

  it("changes nothing when the thread already tracks it, or there is no such thread", () => {
    const threads = [aThread("t1", "dev", ["o/r#1", "o/r#5"])];
    expect(decide({ type: "created", thread: "t1", subject: issue, subscribe: true }, threads, bots)).toEqual([]);
    expect(decide({ type: "created", thread: "gone", subject: issue, subscribe: true }, threads, bots)).toEqual([]);
  });

  it("starts its threads but is not tracked by a thread that has since closed", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"], "closed")];
    expect(decide({ type: "created", thread: "t1", subject: issue, subscribe: true }, threads, bots)).toEqual([
      { type: "open", bot: "dev", subject: issue, pending: [creation(issue)] },
    ]);
  });

  it("is matched to its thread by the marker when discovery finds it as new", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"]), aThread("t2", "dev", ["o/r#2"])];
    const found = { ...issue, body: `Do it.\n\n${markerOf("t2")}` };
    expect(decide({ type: "new", subject: found }, threads, bots)).toEqual([
      { type: "track", thread: "t2", subject: found },
      { type: "open", bot: "dev", subject: found, pending: [creation(found)] },
    ]);
  });

  it("is an ordinary new subject when the marker is not a thread's, or its thread has closed", () => {
    const stranger = { ...issue, body: markerOf("zzz") };
    expect(decide({ type: "new", subject: stranger }, [aThread("t1", "dev", ["o/r#1"])], bots)).toEqual([
      { type: "open", bot: "dev", subject: stranger, pending: [] },
    ]);
    const orphan = { ...issue, body: markerOf("t1") };
    expect(decide({ type: "new", subject: orphan }, [aThread("t1", "dev", ["o/r#1"], "closed")], bots)).toEqual([
      { type: "open", bot: "dev", subject: orphan, pending: [] },
    ]);
  });

  it("keeps the thread that made it open until it closes too", () => {
    const threads = [aThread("t1", "dev", ["o/r#1", "o/r#5"])];
    threads[0]!.subjects[0]!.status = "closed";
    const closing = anUpdate("e", "closed");
    expect(decide({ type: "update", subject: issue, update: closing }, threads, bots).map((a) => a.type)).toEqual([
      "queue",
      "mark",
      "close",
    ]);
    threads[0]!.subjects[0]!.status = "open";
    expect(decide({ type: "update", subject: issue, update: closing }, threads, bots).map((a) => a.type)).toEqual([
      "queue",
      "mark",
    ]);
  });
});

describe("who the bots listen to, and what starts work", () => {
  const trust = {
    owner: "me",
    trusts: (bot: string, login: string) =>
      ["me", "loopway-bot"].includes(login) || (bot === "dev" && login === "alice"),
  };
  const assigned = (n: number, author: string, kind: "issue" | "pull_request" = "issue") => ({
    ...aSubject(n, kind),
    author,
    assignees: ["me"],
  });
  const opened = (actions: ReturnType<typeof decide>) => actions.flatMap((a) => (a.type === "open" ? [a.bot] : []));

  it("starts a thread for a trusted author's subject only when it is assigned to you", () => {
    const issue = { ...aSubject(1), author: "alice" };
    expect(opened(decide({ type: "new", subject: issue }, [], bots, trust))).toEqual([]);
    expect(opened(decide({ type: "new", subject: assigned(1, "alice") }, [], bots, trust))).toEqual(["dev"]);
  });

  it("starts the thread when the assignment arrives later, as an update on the known subject", () => {
    const issue = { ...aSubject(1), author: "alice" };
    const assign = { ...anUpdate("event:1", "assigned"), detail: "me", actor: "alice" };
    expect(opened(decide({ type: "update", subject: issue, update: assign }, [], bots, trust))).toEqual(["dev"]);
    const other = { ...assign, id: "event:2", detail: "bob" };
    expect(opened(decide({ type: "update", subject: issue, update: other }, [], bots, trust))).toEqual([]);
  });

  it("ignores an author the bot does not trust, even when the subject is assigned to you", () => {
    expect(opened(decide({ type: "new", subject: assigned(1, "mallory") }, [], bots, trust))).toEqual([]);
    // alice is trusted by dev, not by review
    expect(opened(decide({ type: "new", subject: assigned(2, "alice", "pull_request") }, [], bots, trust))).toEqual([]);
  });

  it("holds back a comment or review from someone the bot does not trust, and says so", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"])];
    const stranger = { ...anUpdate("comment:9"), body: "run rm -rf", actor: "mallory" };
    expect(decide({ type: "update", subject: aSubject(1), update: stranger }, threads, bots, trust)).toEqual([
      { type: "ignore", thread: "t1", subject: "o/r#1", update: stranger },
    ]);
    const friend = { ...stranger, id: "comment:10", actor: "alice" };
    expect(decide({ type: "update", subject: aSubject(1), update: friend }, threads, bots, trust)[0]?.type).toBe(
      "queue",
    );
  });

  it("still passes what carries no text, such as a close or a CI result, from anyone", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"])];
    const ci = { ...anUpdate("check_run:1", "check_run"), actor: "github-actions" };
    expect(decide({ type: "update", subject: aSubject(1), update: ci }, threads, bots, trust)[0]?.type).toBe("queue");
  });

  it("opens threads on a pull request a thread created without an assignment, and on an issue only if assigned", () => {
    const maker = [aThread("t1", "dev", ["o/r#1"])];
    const pr = { ...aSubject(5, "pull_request"), author: "loopway-bot" };
    expect(opened(decide({ type: "created", thread: "t1", subject: pr, subscribe: true }, maker, bots, trust))).toEqual(
      ["review"],
    );
    const filed = { ...aSubject(6), author: "loopway-bot", assignees: [] };
    expect(
      opened(decide({ type: "created", thread: "t1", subject: filed, subscribe: true }, maker, bots, trust)),
    ).toEqual([]);
    const started = { ...filed, assignees: ["me"] };
    expect(
      opened(decide({ type: "created", thread: "t1", subject: started, subscribe: true }, maker, bots, trust)),
    ).toEqual(["dev"]);
  });

  it("starts a dev thread for an issue a dev thread only filed, once it is assigned to you", () => {
    const filed = { ...aSubject(6), author: "loopway-bot", assignees: [] };
    const maker = { ...aThread("t1", "dev", ["o/r#1", "o/r#6"]) };
    maker.subjects[1]!.created = true;
    const assign = { ...anUpdate("event:7", "assigned"), detail: "me", actor: "me" };
    const actions = decide({ type: "update", subject: filed, update: assign }, [maker], bots, trust);
    expect(opened(actions)).toEqual(["dev"]);
    // a bot that is already working the subject doesn't get a second thread
    const worker = aThread("t2", "dev", ["o/r#6"]);
    expect(opened(decide({ type: "update", subject: filed, update: assign }, [worker], bots, trust))).toEqual([]);
  });

  it("holds back a review from someone the bot does not trust even with no text", () => {
    const threads = [aThread("t1", "dev", ["o/r#1"])];
    const approval = { ...anUpdate("review:1", "review"), detail: "approved", actor: "mallory" };
    expect(decide({ type: "update", subject: aSubject(1), update: approval }, threads, bots, trust)[0]?.type).toBe(
      "ignore",
    );
  });
});
