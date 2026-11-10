#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadBots, reposOf } from "./bots.js";
import { loadGitHubConfig, loopwayHome } from "./config.js";
import { formatJson, formatLine, formatThread, formatThreadJson, type LoopwayEvent } from "./format.js";
import { ghToken, GitHubSource } from "./github.js";
import { Poller } from "./poller.js";
import { loadState, saveState } from "./state.js";
import { loadThreads, readThreadLog, Threads, visibleThreads } from "./threads.js";
import { showTui } from "./tui.js";

const HELP = `loopway: watches GitHub and prints every new issue and pull request by you or your bot,
and every update to the ones it knows.

Usage: loopway [--no-tui] [--json]
       loopway threads [--json]

In a terminal it opens a TUI: the open threads and those closed in the last 3 days. Enter opens a thread, q quits.
With --no-tui, --json, or output that isn't a terminal, it prints a plain log instead.

Each new issue or pull request starts a thread for every bot whose rules ask for it (on: issue, on: pull_request),
and every update to it goes on the queue of the open threads that hold it. \`loopway threads\` lists the open ones,
and those closed in the last 3 days.

Run it from a directory with a .loopway/ folder: one <bot>.md per bot, with front matter like
  repos: [owner/name]
Credentials come from gh (gh auth login). State lives in ~/.loopway (or $LOOPWAY_HOME).

  --no-tui     print the plain log even in a terminal
  --json       print one JSON object per line (implies --no-tui)
  --version    print the version
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      json: { type: "boolean" },
      "no-tui": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  if (positionals[0] === "threads") return listThreads(loopwayHome(), values.json);
  if (positionals.length > 0) throw new Error(`Unknown command "${positionals[0]}". Try loopway --help.`);

  // `npm run cli` runs in the package directory; INIT_CWD is where it was typed.
  const bots = await loadBots(process.env.INIT_CWD || process.cwd());
  const repos = reposOf(bots);
  if (repos.length === 0) {
    console.error(
      "Nothing to read. Add .loopway/<bot>.md here, with front matter like:\n\n---\nrepos: [owner/name]\n---",
    );
    return 1;
  }

  const home = loopwayHome();
  const bot = (await loadGitHubConfig(home)).name;
  const source = new GitHubSource({ token: ghToken() });
  const me = await source.whoami();
  const authors = bot ? [me, bot] : [me];
  const state = await loadState(home);
  const threads = await Threads.load({ home, bots });

  // In the TUI nothing prints: the bottom of the screen shows the latest line.
  const tui = !values.json && !values["no-tui"] && !!process.stdout.isTTY && !!process.stdin.isTTY;
  let latest = "";
  const say = (line: string) => (tui ? (latest = line) : console.log(line));
  const log = (message: string) => (tui ? (latest = message) : console.error(message));
  if (!tui) console.error(`loopway ${pkg.version}: watching ${repos.join(", ")} for ${authors.join(" and ")}`);
  const print = (event: LoopwayEvent) => say(values.json ? formatJson(event) : formatLine(event));
  // A thread's lines follow the line of the event that caused them.
  const emit = async (event: LoopwayEvent) => {
    print(event);
    for (const threadEvent of await threads.handle(event)) print(threadEvent);
  };
  const poller = new Poller({
    source,
    state,
    save: (s) => saveState(home, s),
    repos,
    authors,
    emit,
    log,
  });

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
  const polling = poller.run(stop.signal);
  if (tui) {
    const props = {
      threads: () => threads.all,
      readLog: (id: string) => readThreadLog(home, id),
      latest: () => latest,
    };
    await showTui(props).finally(() => stop.abort());
  }
  await polling;
  return 0;
}

async function listThreads(home: string, json: boolean | undefined): Promise<number> {
  for (const thread of visibleThreads(await loadThreads(home), Date.now())) {
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
