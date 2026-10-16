// The GitHub bot identity for the bb threads of loopway threads, as `loopway bots run` gives its sessions (see
// botEnv in the CLI's bots/github.ts): `gh` and git push as the bot, and commits are the bot's.
//
// bb shows contributed environment values in each thread's timeline, so the token doesn't go in GH_TOKEN. It
// goes in a gh config dir of the runner's own, which GH_CONFIG_DIR points gh at, and git gets it from
// `gh auth git-credential`. Every value in the environment is safe to show.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GithubBot } from "@loopway/cli/src/config.js";

export interface EnvEntry {
  name: string;
  value: string;
  reason: string;
}

/** Writes `dir/hosts.yml` (0600, in a 0700 dir) logging gh in to github.com as the bot. */
export async function writeGhConfig(dir: string, bot: GithubBot): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "hosts.yml");
  // JSON strings are YAML strings, so a name with odd characters can't break the file.
  const yaml = [
    "github.com:",
    `    oauth_token: ${JSON.stringify(bot.token)}`,
    `    user: ${JSON.stringify(bot.name)}`,
    "    git_protocol: https",
    "",
  ].join("\n");
  await writeFile(path, yaml, { mode: 0o600 });
  await chmod(path, 0o600); // mode only applies on create
}

/** The environment that makes a session act as the bot whose gh config is in `dir`. */
export function botEnvEntries(dir: string, bot: GithubBot): EnvEntry[] {
  const reason = `Act on GitHub as the loopway bot ${bot.name}, as \`loopway bots run\` sessions do`;
  const git: [string, string][] = [
    // The user's own helpers (keychain, their gh login) are reset so they can't answer first.
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    // SSH remotes go over HTTPS, so the push uses the bot's token.
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  return [
    { name: "GH_CONFIG_DIR", value: dir, reason },
    // A token in the environment would beat the config dir; empty means unset to gh.
    { name: "GH_TOKEN", value: "", reason },
    { name: "GITHUB_TOKEN", value: "", reason },
    { name: "GIT_AUTHOR_NAME", value: bot.name, reason },
    { name: "GIT_AUTHOR_EMAIL", value: bot.email, reason },
    { name: "GIT_COMMITTER_NAME", value: bot.name, reason },
    { name: "GIT_COMMITTER_EMAIL", value: bot.email, reason },
    { name: "GIT_CONFIG_COUNT", value: String(git.length), reason },
    ...git.flatMap(([key, value], i) => [
      { name: `GIT_CONFIG_KEY_${i}`, value: key, reason },
      { name: `GIT_CONFIG_VALUE_${i}`, value, reason },
    ]),
  ];
}
