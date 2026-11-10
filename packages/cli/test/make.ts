import type { Bot } from "../src/bots.js";
import type { Subject, Update } from "../src/source.js";
import type { Thread } from "../src/thread.js";

export const aBot = (name: string, on: Bot["on"], repos = ["o/r"]): Bot => ({ name, repos, on, rules: {}, prompt: "" });

export const dev = aBot("dev", ["issue"]);
export const review = aBot("review", ["pull_request"]);

export const aSubject = (n: number, kind: Subject["kind"] = "issue", repo = "o/r"): Subject => ({
  key: `${repo}#${n}`,
  kind,
  title: `title of ${repo}#${n}`,
  author: "me",
  createdAt: "2026-11-10T12:30:00Z",
});

export const anUpdate = (id: string, kind = "comment", at = "2026-11-10T14:05:00Z"): Update => ({
  id,
  kind,
  actor: "me",
  at,
});

export const aThread = (id: string, bot: string, subjects: string[], status: Thread["status"] = "open"): Thread => ({
  id,
  bot,
  subjects: subjects.map((key) => ({ key, status })),
  status,
  createdAt: "2026-11-10T14:02:00Z",
  latestAt: "2026-11-10T14:02:00Z",
  queue: [],
});
