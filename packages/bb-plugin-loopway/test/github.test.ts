import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botEnvEntries, writeGhConfig } from "../github.js";

const bot = { token: "ghp_secret123", name: "loopway-bot", email: "2+loopway-bot@users.noreply.github.com" };

describe("the GitHub bot identity", () => {
  it("logs gh in as the bot in a config dir only the user can read", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "bb-loopway-gh-")), "gh");
    await writeGhConfig(dir, bot);
    const path = join(dir, "hosts.yml");
    expect(await readFile(path, "utf8")).toBe(
      'github.com:\n    oauth_token: "ghp_secret123"\n    user: "loopway-bot"\n    git_protocol: https\n',
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("points gh and git at it without putting the token in the environment", () => {
    const entries = botEnvEntries("/home/me/.loopway/bb-runner/gh", bot);
    const env = Object.fromEntries(entries.map((e) => [e.name, e.value]));
    expect(env).toMatchObject({
      GH_CONFIG_DIR: "/home/me/.loopway/bb-runner/gh",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GIT_AUTHOR_NAME: "loopway-bot",
      GIT_COMMITTER_EMAIL: bot.email,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    });
    expect(JSON.stringify(entries)).not.toContain(bot.token);
    // bb takes at most 32, with unique names, each with a reason.
    expect(entries.length).toBeLessThanOrEqual(31);
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
    expect(entries.every((e) => /^[A-Z_][A-Z0-9_]*$/.test(e.name) && e.reason)).toBe(true);
  });
});
