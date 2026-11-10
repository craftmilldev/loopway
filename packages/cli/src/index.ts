#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadBots, reposOf } from "./bots.js";
import { loadGitHubConfig, loopwayHome } from "./config.js";
import { formatJson, formatLine, type LoopwayEvent } from "./format.js";
import { ghToken, GitHubSource } from "./github.js";
import { Poller } from "./poller.js";
import { loadState, saveState } from "./state.js";

const HELP = `loopway: watches GitHub and prints every new issue and pull request by you or your bot,
and every update to the ones it knows.

Usage: loopway [--json]

Run it from a directory with a .loopway/ folder: one <bot>.md per bot, with front matter like
  repos: [owner/name]
Credentials come from gh (gh auth login). State lives in ~/.loopway (or $LOOPWAY_HOME).

  --json       print one JSON object per line
  --version    print the version
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" } },
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

  console.error(`loopway ${pkg.version}: watching ${repos.join(", ")} for ${authors.join(" and ")}`);
  const print = (event: LoopwayEvent) => console.log(values.json ? formatJson(event) : formatLine(event));
  const poller = new Poller({
    source,
    state,
    save: (s) => saveState(home, s),
    repos,
    authors,
    emit: print,
    log: (message) => console.error(message),
  });

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
  await poller.run(stop.signal);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
