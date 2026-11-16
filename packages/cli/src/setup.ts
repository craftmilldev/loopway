import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGitHubConfig, saveGitHubConfig } from "./config.js";

/** What `loopway setup` needs from the terminal. The real one is Ink (setup-io.tsx); tests script it. */
export interface Io {
  say: (line: string, tone?: "ok" | "warn" | "fail") => void;
  choose: <T extends string>(question: string, options: { value: T; label: string }[]) => Promise<T>;
  text: (question: string, initial?: string) => Promise<string>;
  /** Like `text`, but shows dots: for a token. */
  secret: (question: string) => Promise<string>;
  /** Runs a command with the terminal handed over (`gh auth login` asks its own questions). Its exit code. */
  run: (command: string, args: string[]) => Promise<number>;
}

export interface SetupDeps {
  io: Io;
  /** `~/.loopway`: where the bot's token goes. */
  home: string;
  /** Where `.loopway/` is made. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  /** A command's output, or undefined when it isn't there or failed. */
  exec?: (command: string, args: string[]) => string | undefined;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

const defaultExec = (command: string, args: string[]) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

/** Runs a command with the terminal inherited. */
export const runInherited = async (command: string, args: string[]) =>
  spawnSync(command, args, { stdio: "inherit" }).status ?? 1;

const bot = (repos: string[], on: string, prompt: string) =>
  `---\nrepos: [${repos.join(", ")}]\non: ${on}\n---\n\n${prompt}\n`;

/** The two starter bot files: the ones in the README. */
export const BOT_FILES = {
  "dev.md": (repos: string[]) =>
    bot(
      repos,
      "issue",
      "You are the dev bot. When an issue is assigned to you, read it, make the change on a branch, run the tests, and open\na pull request that says `Closes #N`. Ask on the issue when something is unclear.",
    ),
  "review.md": (repos: string[]) =>
    bot(
      repos,
      "pull_request",
      "You are the review bot. Read the pull request and its diff, check it against the issue it closes, and leave a\nreview. Be specific, and say what you ran.",
    ),
};

/** `owner/name` from a GitHub remote URL (https or ssh), or undefined. */
export function repoFromRemote(url: string | undefined): string | undefined {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return match?.[1];
}

/**
 * Walks through what loopway needs: `gh` logged in, Claude Code, the bot user's token, and the bot files. Each step
 * checks first and only asks about what is missing; nothing is overwritten, and the steps that can be left out say
 * so. Returns the exit code: 1 when a step loopway can't run without was not done.
 */
export async function runSetup(deps: SetupDeps): Promise<number> {
  const { io, home, cwd } = deps;
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const api = deps.fetch ?? globalThis.fetch;
  const get = (token: string, path: string) =>
    api(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "loopway" },
    }).catch(() => undefined);
  const who = async (token: string) => {
    const res = await get(token, "/user");
    if (!res?.ok) return undefined;
    const user = (await res.json()) as { login: string; id: number };
    return user;
  };

  io.say("loopway setup: each step checks first, and only asks about what is missing.");

  // 1. gh, which loopway acts as you through. Required.
  if (exec("gh", ["--version"]) === undefined) {
    io.say("gh isn't installed. Install it from https://cli.github.com, then run `loopway setup` again.", "fail");
    return 1;
  }
  // The same order as ghToken (github.ts), but through `exec` so a test never reaches the real gh.
  const login = () => env.GH_TOKEN || env.GITHUB_TOKEN || exec("gh", ["auth", "token"]) || undefined;
  let token = login();
  if (!token) {
    const answer = await io.choose("gh isn't logged in to GitHub.", [
      { value: "login", label: "Log in now (runs `gh auth login`)" },
      { value: "stop", label: "Stop here" },
    ]);
    if (answer === "login") {
      await io.run("gh", ["auth", "login"]);
      token = login();
    }
  }
  const me = token ? await who(token) : undefined;
  if (!token || !me) {
    io.say(token ? "GitHub didn't accept the gh login." : "No gh login, and loopway can't run without one.", "fail");
    return 1;
  }
  io.say(`gh is logged in as ${me.login}.`, "ok");

  // 2. Claude Code, which runs the sessions. Setup carries on without it: it's only needed to run one.
  const claude = exec("claude", ["--version"]);
  if (claude === undefined) {
    io.say(
      "Claude Code isn't on your PATH. Sessions need it: install it from https://claude.com/claude-code. Carrying on.",
      "warn",
    );
  } else io.say(`Claude Code is installed (${claude}).`, "ok");

  // 3. The bot user. Optional: without its token loopway watches and queues, but runs no sessions.
  const config = await loadGitHubConfig(home);
  let botDone = false;
  if (config.token) {
    const existing = await who(config.token);
    if (existing) {
      io.say(`The bot user is ${existing.login} (from ${join(home, "config.json")}).`, "ok");
      botDone = true;
    } else io.say(`The token in ${join(home, "config.json")} isn't accepted by GitHub.`, "warn");
  }
  let skipped = false;
  while (!botDone && !skipped) {
    const answer = await io.choose(
      "A bot user acts on your issues so it isn't you commenting. It's a separate GitHub account with its own token.",
      [
        { value: "add", label: "Add the bot's token" },
        { value: "skip", label: "Skip it: loopway will watch and queue, but run no sessions" },
      ],
    );
    if (answer === "skip") {
      skipped = true;
      break;
    }
    const given = (await io.secret("The bot account's GitHub token (a personal access token with repo scope)")).trim();
    const bot = given ? await who(given) : undefined;
    if (!bot) io.say("GitHub didn't accept that token.", "fail");
    else if (bot.login.toLowerCase() === me.login.toLowerCase())
      io.say(
        `That token is your own account (${me.login}): the bot would comment as you. Use another account's.`,
        "warn",
      );
    else {
      await saveGitHubConfig(home, {
        token: given,
        name: bot.login,
        email: `${bot.id}+${bot.login}@users.noreply.github.com`,
      });
      io.say(`Saved ${bot.login} as the bot user in ${join(home, "config.json")}.`, "ok");
      botDone = true;
    }
  }
  if (skipped) io.say("Skipped the bot user: sessions are off until you add one (run `loopway setup` again).", "warn");

  // 4. The bot files in .loopway/. Never overwrites one.
  const folder = join(cwd, ".loopway");
  const missing: string[] = [];
  for (const file of Object.keys(BOT_FILES)) {
    const present = await readFile(join(folder, file), "utf8").then(
      () => true,
      () => false,
    );
    if (present) io.say(`.loopway/${file} is already here: left as it is.`, "ok");
    else missing.push(file);
  }
  const wanted: string[] = [];
  for (const file of missing) {
    const answer = await io.choose(`Add .loopway/${file} here (${cwd})?`, [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No, skip it" },
    ]);
    if (answer === "yes") wanted.push(file);
    else io.say(`Skipped .loopway/${file}.`, "warn");
  }
  if (wanted.length > 0) {
    const repos = await askRepos(io, repoFromRemote(exec("git", ["-C", cwd, "remote", "get-url", "origin"])));
    for (const repo of repos) {
      const found = await get(token, `/repos/${repo}`);
      if (!found?.ok)
        io.say(`Couldn't see ${repo} as ${me.login}: check the name and your access. Using it anyway.`, "warn");
    }
    await mkdir(folder, { recursive: true });
    for (const file of wanted) {
      const make = BOT_FILES[file as keyof typeof BOT_FILES];
      try {
        await writeFile(join(folder, file), make(repos), { flag: "wx" }); // wx: if it showed up meanwhile, keep it
        io.say(`Wrote .loopway/${file} for ${repos.join(", ")}.`, "ok");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        io.say(`.loopway/${file} appeared meanwhile: left as it is.`, "warn");
      }
    }
  }

  io.say("Done. Run `loopway` here, then create an issue on GitHub and assign it to yourself.", "ok");
  return 0;
}

/** Asks for `owner/name`, comma separated, until every one is well formed. */
async function askRepos(io: Io, guess: string | undefined): Promise<string[]> {
  for (;;) {
    const answer = await io.text("Which repos should the bots watch? (owner/name, separated by commas)", guess);
    const repos = answer
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (repos.length > 0 && repos.every((r) => REPO.test(r))) return repos;
    io.say(`"${answer}" isn't a list of owner/name.`, "fail");
  }
}
