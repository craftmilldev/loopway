import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBot } from "../src/bots.js";
import { repoFromRemote, runSetup, type Io, type SetupDeps } from "../src/setup.js";

/** A scripted terminal: answers come off a queue, and everything said and asked is kept. */
function script(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const ran: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected question: ${question}`);
    return answer;
  };
  const io: Io = {
    say: (line, tone) => said.push(`${tone ?? "-"} ${line}`),
    choose: async (question) => next(question) as never,
    text: async (question) => next(question),
    secret: async (question) => next(question),
    run: async (command, args) => {
      ran.push([command, ...args].join(" "));
      return 0;
    },
  };
  return { io, said, asked, ran };
}

const users: Record<string, { login: string; id: number }> = {
  mytoken: { login: "me", id: 1 },
  bottoken: { login: "the-bot", id: 77 },
};
const repos = new Set(["o/r"]);

/** GitHub: /user by token, and /repos/<name> for the repos in `repos`. */
const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
  const token = init.headers.authorization!.replace("Bearer ", "");
  const path = url.replace("https://api.github.com", "");
  if (path === "/user") {
    const user = users[token];
    return user ? Response.json(user) : new Response("{}", { status: 401 });
  }
  return new Response("{}", { status: repos.has(path.replace("/repos/", "")) ? 200 : 404 });
}) as unknown as typeof fetch;

async function setup(more: Partial<SetupDeps> = {}, answers: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "loopway-setup-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const terminal = script(answers);
  const deps: SetupDeps = {
    io: terminal.io,
    home,
    cwd,
    env: { GH_TOKEN: "mytoken" },
    fetch: fakeFetch,
    exec: (command, args) =>
      command === "claude" ? "2.1.0 (Claude Code)" : command === "git" ? "git@github.com:o/r.git" : args[0] ? "ok" : "",
    ...more,
  };
  return { ...terminal, deps, home, cwd, run: () => runSetup(deps) };
}

/** gh is installed but has no login; nothing else is there. */
const onlyGhVersion = (c: string, args: string[]) => (c === "gh" && args[0] === "--version" ? "gh version" : undefined);

describe("loopway setup", () => {
  it("walks a fresh machine: bot token, then both bot files for the guessed repo", async () => {
    const t = await setup({}, ["add", "bottoken", "yes", "yes", "o/r"]);
    expect(await t.run()).toBe(0);
    expect(t.said.join("\n")).toMatch(/gh is logged in as me/);
    expect(t.said.join("\n")).toMatch(/Claude Code is installed/);
    const config = JSON.parse(await readFile(join(t.home, "config.json"), "utf8"));
    expect(config.github).toEqual({
      token: "bottoken",
      name: "the-bot",
      email: "77+the-bot@users.noreply.github.com",
    });
    expect((await stat(join(t.home, "config.json"))).mode & 0o777).toBe(0o600);
    for (const [file, on] of [
      ["dev.md", "issue"],
      ["review.md", "pull_request"],
    ] as const) {
      const bot = parseBot(file.slice(0, -3), await readFile(join(t.cwd, ".loopway", file), "utf8"));
      expect(bot.repos).toEqual(["o/r"]);
      expect(bot.on).toEqual([on]);
    }
    expect(t.said.join("\n")).not.toContain("bottoken"); // the token is never printed
  });

  it("asks nothing when everything is already set up, and changes nothing", async () => {
    const t = await setup();
    await mkdir(join(t.home), { recursive: true });
    await writeFile(join(t.home, "config.json"), JSON.stringify({ auto_update: false, github: { token: "bottoken" } }));
    await mkdir(join(t.cwd, ".loopway"));
    await writeFile(join(t.cwd, ".loopway", "dev.md"), "mine");
    await writeFile(join(t.cwd, ".loopway", "review.md"), "mine too");
    expect(await t.run()).toBe(0);
    expect(t.asked).toEqual([]);
    expect(await readFile(join(t.cwd, ".loopway", "dev.md"), "utf8")).toBe("mine");
    expect(JSON.parse(await readFile(join(t.home, "config.json"), "utf8")).auto_update).toBe(false);
  });

  it("lets the bot user and each bot file be skipped", async () => {
    // No claude and no git remote, so the repo is asked.
    const t2 = await setup(
      { env: { GH_TOKEN: "mytoken" }, exec: (c, a) => (c === "gh" && a[0] === "--version" ? "gh version" : undefined) },
      ["skip", "yes", "no", "o/r"],
    );
    expect(await t2.run()).toBe(0);
    expect(t2.said.join("\n")).toMatch(/warn Claude Code isn't on your PATH/);
    expect(t2.said.join("\n")).toMatch(/sessions are off/);
    await expect(stat(join(t2.home, "config.json"))).rejects.toThrow();
    await expect(readFile(join(t2.cwd, ".loopway", "dev.md"), "utf8")).resolves.toContain("repos: [o/r]");
    await expect(stat(join(t2.cwd, ".loopway", "review.md"))).rejects.toThrow();
  });

  it("offers gh auth login when gh has no login, and stops when it is declined or still fails", async () => {
    const t = await setup({ env: {}, exec: onlyGhVersion }, ["login"]);
    expect(await t.run()).toBe(1);
    expect(t.ran).toEqual(["gh auth login"]);
    const declined = await setup({ env: {}, exec: onlyGhVersion }, ["stop"]);
    expect(await declined.run()).toBe(1);
    expect(declined.ran).toEqual([]);
  });

  it("stops when gh isn't installed", async () => {
    const t = await setup({ exec: () => undefined });
    expect(await t.run()).toBe(1);
    expect(t.said.join("\n")).toMatch(/fail gh isn't installed/);
  });

  it("refuses a bad token and your own account's, and asks again", async () => {
    users.mytoken2 = { login: "me", id: 1 };
    const t = await setup({}, ["add", "nonsense", "add", "mytoken2", "skip", "no", "no"]);
    expect(await t.run()).toBe(0);
    const said = t.said.join("\n");
    expect(said).toMatch(/GitHub didn't accept that token/);
    expect(said).toMatch(/your own account \(me\)/);
    await expect(stat(join(t.home, "config.json"))).rejects.toThrow();
  });

  it("replaces a bot token GitHub no longer accepts, and keeps the rest of config.json", async () => {
    const t = await setup({}, ["add", "bottoken", "no", "no"]);
    await mkdir(t.home, { recursive: true });
    await writeFile(join(t.home, "config.json"), JSON.stringify({ auto_update: false, github: { token: "stale" } }));
    expect(await t.run()).toBe(0);
    const config = JSON.parse(await readFile(join(t.home, "config.json"), "utf8"));
    expect(config.auto_update).toBe(false);
    expect(config.github.token).toBe("bottoken");
  });

  it("asks again for a repo that isn't owner/name, and warns about one it can't see, but still writes", async () => {
    const t = await setup({ exec: (c) => (c === "git" ? undefined : "ok") }, ["skip", "yes", "no", "nope", "a/b, c/d"]);
    expect(await t.run()).toBe(0);
    const said = t.said.join("\n");
    expect(said).toMatch(/"nope" isn't a list of owner\/name/);
    expect(said).toMatch(/Couldn't see a\/b/);
    expect(await readFile(join(t.cwd, ".loopway", "dev.md"), "utf8")).toContain("repos: [a/b, c/d]");
  });

  it("reads owner/name from a GitHub remote", () => {
    expect(repoFromRemote("git@github.com:craftmilldev/loopway.git")).toBe("craftmilldev/loopway");
    expect(repoFromRemote("https://github.com/craftmilldev/loopway")).toBe("craftmilldev/loopway");
    expect(repoFromRemote("https://example.com/a/b")).toBeUndefined();
    expect(repoFromRemote(undefined)).toBeUndefined();
  });
});
