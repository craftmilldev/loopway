import { describe, expect, it } from "vitest";
import { decide } from "../src/rules.js";
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
