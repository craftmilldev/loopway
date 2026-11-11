#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadBots, reposOf, type Bot } from "./bots.js";
import { claudeRunner } from "./claude.js";
import { loadGitHubConfig, loopwayHome, type GitHubConfig } from "./config.js";
import { formatJson, formatLine, formatThread, formatThreadJson, type LoopwayEvent } from "./format.js";
import { ghToken, GitHubSource } from "./github.js";
import { startMcp } from "./mcp.js";
import { Poller } from "./poller.js";
import { findProject } from "./project.js";
import { Sessions } from "./sessions.js";
import { loadState, saveState, stateDir } from "./state.js";
import { loadThreads, readThreadLog, Threads, visibleThreads } from "./threads.js";
import { showTui } from "./tui.js";
import { formatPollStatus } from "./tui-text.js";

const HELP = `loopway: watches GitHub and prints every new issue and pull request by you or your bot,
and every update to the ones it knows.

Usage: loopway [--project DIR] [--no-tui] [--json] [--max N]
       loopway threads [--project DIR] [--json]

In a terminal it opens a TUI: the open threads and those closed in the last 3 days. Enter opens a thread, q quits.
With --no-tui, --json, or output that isn't a terminal, it prints a plain log instead.

Each new issue or pull request starts a thread for every bot whose rules ask for it (on: issue, on: pull_request),
and every update to it goes on the queue of the open threads that hold it. Each thread's queue goes to a Claude Code
session that acts as the bot user and talks back through loopway's own MCP tool. \`loopway threads\` lists the open
threads, and those closed in the last 3 days.

Run it in a project: it walks up from where you are to the nearest directory with a .loopway/ folder, like git
finds a repo, and prints which one it found. Each project has one <bot>.md per bot, with front matter like
  repos: [owner/name]
  model: sonnet
Credentials come from gh (gh auth login), and the bot's from ~/.loopway/config.json (or $LOOPWAY_HOME).
State is per project, in ~/.loopway/state/<the project's path>.

  --project D  use the .loopway/ in directory D, and skip the search
  --no-tui     print the plain log even in a terminal
  --json       print one JSON object per line (implies --no-tui)
  --max N      runs in flight at once (default 3)
  --version    print the version
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      "no-tui": { type: "boolean" },
      max: { type: "string", default: "3" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 1)
    throw new Error("--max is how many runs may be in flight: a whole number, 1 or more");
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const project = findProject(process.cwd(), loopwayHome(), values.project);
  if (positionals[0] === "threads") return listThreads(stateDir(loopwayHome(), project), values.json);
  if (positionals.length > 0) throw new Error(`Unknown command "${positionals[0]}". Try loopway --help.`);

  const bots = await loadBots(project);
  const repos = reposOf(bots);
  if (repos.length === 0) {
    console.error(
      `Nothing to read in ${join(project, ".loopway")}. Add <bot>.md files there, with front matter like:\n\n---\nrepos: [owner/name]\n---`,
    );
    return 1;
  }

  const dir = stateDir(loopwayHome(), project);
  const config = await loadGitHubConfig(loopwayHome());
  const source = new GitHubSource({ token: ghToken() });
  const me = await source.whoami();
  const authors = config.name ? [me, config.name] : [me];
  const state = await loadState(dir);
  const threads = await Threads.load({ dir, bots });

  // In the TUI nothing prints: the bottom of the screen shows the latest line.
  const tui = !values.json && !values["no-tui"] && !!process.stdout.isTTY && !!process.stdin.isTTY;
  let latest = "";
  const say = (line: string) => (tui ? (latest = line) : console.log(line));
  const log = (message: string) => (tui ? (latest = message) : console.error(message));
  if (!tui)
    console.error(
      `loopway ${pkg.version}: ${join(project, ".loopway")}: watching ${repos.join(", ")} for ${authors.join(" and ")}`,
    );
  const print = (event: LoopwayEvent) => say(values.json ? formatJson(event) : formatLine(event));
  const stop = new AbortController();
  const sessions = await startSessions({
    dir,
    config,
    threads,
    bots,
    root: project,
    max,
    print,
    log,
    stop: stop.signal,
  });
  // A thread's lines follow the line of the event that caused them.
  const emit = async (event: LoopwayEvent) => {
    print(event);
    for (const threadEvent of await threads.handle(event)) print(threadEvent);
    sessions?.kick();
  };
  const poller = new Poller({
    source,
    state,
    save: (s) => saveState(dir, s),
    repos,
    authors,
    emit,
    log,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
  const polling = poller.run(stop.signal);
  if (tui) {
    const props = {
      threads: () => threads.all,
      readLog: (id: string) => readThreadLog(dir, id),
      latest: () => latest,
      status: (now: number) => formatPollStatus(repos, poller.status(), now),
      onRefresh: () => void poller.refresh(),
      project,
    };
    await showTui(props).finally(() => stop.abort());
  }
  await polling;
  await sessions?.done;
  return 0;
}

interface SessionsSetup {
  dir: string;
  config: GitHubConfig;
  threads: Threads;
  bots: Bot[];
  root: string;
  max: number;
  print: (event: LoopwayEvent) => void;
  log: (message: string) => void;
  stop: AbortSignal;
}

/**
 * Starts the sessions: loopway's MCP server, and the loop that delivers queued updates. They act as the bot user, so
 * without its token in config.json there are none, and threads only queue.
 */
async function startSessions(s: SessionsSetup): Promise<{ kick: () => void; done: Promise<void> } | undefined> {
  const { token, name, email } = s.config;
  if (!token) {
    s.log("No github.token in ~/.loopway/config.json: sessions are off, and threads only queue.");
    return undefined;
  }
  const botEnv = { GH_TOKEN: token, ...gitIdentity(name, email) };
  const mcp = await startMcp({ comment: (thread, subject, body) => sessions.comment(thread, subject, body) });
  const sessions = new Sessions({
    dir: s.dir,
    threads: s.threads,
    bots: s.bots,
    root: s.root,
    max: s.max,
    runAgent: claudeRunner(),
    mcpUrl: (threadId) => mcp.urlFor(threadId),
    env: botEnv,
    commenter: new GitHubSource({ token }),
    emit: s.print,
  });
  const done = sessions.run(s.stop).then(() => mcp.close());
  return { kick: () => sessions.kick(), done };
}

/** The git author and committer for the bot's commits. */
function gitIdentity(name?: string, email?: string): Record<string, string> {
  const identity: Record<string, string> = {};
  if (name) Object.assign(identity, { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name });
  if (email) Object.assign(identity, { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email });
  return identity;
}

async function listThreads(dir: string, json: boolean | undefined): Promise<number> {
  for (const thread of visibleThreads(await loadThreads(dir), Date.now())) {
    console.log(json ? formatThreadJson(thread) : formatThread(thread));
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
