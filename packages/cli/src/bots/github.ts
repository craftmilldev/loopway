import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GithubBot } from "../config.js";

/** The config directory the bot's `gh` uses, made on demand. Only the bot's token (GH_TOKEN) is ever used with it. */
export function ghConfigDir(configDir: string): string {
  const dir = join(configDir, "gh");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Hands the token to git as the password for https://github.com; reads GH_TOKEN so the token isn't in git config. */
const CREDENTIAL_HELPER = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f`;

/**
 * The environment for sessions that act as a GitHub bot instead of the user running `loopway bots run`:
 *
 * - `gh` uses GH_TOKEN over its stored login, so comments and PRs come from the bot. GITHUB_TOKEN is
 *   set too, so other tools that read it don't pick up a token the user exported.
 * - git gets the bot's token for github.com, with the user's own helpers (keychain, `gh auth`) reset
 *   so they can't answer first, and SSH remotes go over HTTPS so the push uses that token.
 * - Commits are authored and committed by the bot.
 *
 * - `gh` reads its config from `GH_CONFIG_DIR` (a Loopway-owned directory, `<configDir>/gh`) so it can start in the
 *   sandbox without reading the user's own `~/.config/gh`, which stays denied.
 *
 * The git settings go in GIT_CONFIG_KEY_n/VALUE_n, after any the environment already has.
 */
export function botEnv(env: NodeJS.ProcessEnv, bot: GithubBot, configDir: string): NodeJS.ProcessEnv {
  const git: [string, string][] = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  const out: NodeJS.ProcessEnv = {
    ...env,
    GH_TOKEN: bot.token,
    GITHUB_TOKEN: bot.token,
    GH_CONFIG_DIR: ghConfigDir(configDir),
    GIT_AUTHOR_NAME: bot.name,
    GIT_AUTHOR_EMAIL: bot.email,
    GIT_COMMITTER_NAME: bot.name,
    GIT_COMMITTER_EMAIL: bot.email,
  };
  const start = Number(env.GIT_CONFIG_COUNT) || 0;
  git.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(start + git.length);
  return out;
}
