import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../src/context.js";
import {
  availableUpdate,
  defaultDeps,
  installRelease,
  isNewer,
  releaseVersion,
  updateCommand,
  updatesEnabled,
  type UpdateDeps,
} from "../src/update.js";
import { CLI_VERSION } from "../src/version.js";

const [major, minor, patch] = CLI_VERSION.split(".").map(Number) as [number, number, number];
const NEWER = `${major}.${minor}.${patch + 1}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loopway-update-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function setup(opts: { latest?: string; env?: NodeJS.ProcessEnv; needs?: string[] } = {}) {
  const urls: string[] = [];
  const installed: string[][] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    if (url.includes("api.github.com")) {
      return opts.latest
        ? Response.json({ tag_name: `cli-v${opts.latest}` })
        : new Response("rate limited", { status: 403 });
    }
    return new Response("tarball");
  }) as unknown as typeof globalThis.fetch;
  const ctx: Context = { configDir: dir, env: opts.env ?? {}, interactive: false, out: () => {}, fetch };
  const deps: UpdateDeps = {
    installed: true,
    needs: async () => opts.needs ?? [],
    install: async (files) => void installed.push(files),
    now: () => 1_000_000,
  };
  return { ctx, deps, urls, installed };
}

describe("versions", () => {
  it("reads x.y.z from cli-v tags only", () => {
    expect(releaseVersion("cli-v1.2.3")).toBe("1.2.3");
    expect(releaseVersion("v1.2.3")).toBeUndefined();
    expect(releaseVersion("cli-v1.2.3-beta.1")).toBeUndefined();
  });

  it("compares numerically", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("updatesEnabled", () => {
  it("is on for an installed CLI", async () => {
    const { ctx, deps } = setup();
    expect(await updatesEnabled(ctx, deps)).toBe(true);
  });

  it("is off for a checkout", async () => {
    const { ctx, deps } = setup();
    expect(await updatesEnabled(ctx, { ...deps, installed: false })).toBe(false);
  });

  it("is off with LOOPWAY_NO_UPDATE", async () => {
    const { ctx, deps } = setup({ env: { LOOPWAY_NO_UPDATE: "1" } });
    expect(await updatesEnabled(ctx, deps)).toBe(false);
  });

  it("is off with auto_update false in config.json", async () => {
    const { ctx, deps } = setup();
    await writeFile(join(dir, "config.json"), JSON.stringify({ api_url: "https://x.test", auto_update: false }));
    expect(await updatesEnabled(ctx, deps)).toBe(false);
  });
});

describe("availableUpdate", () => {
  it("returns a newer release", async () => {
    const { ctx, deps } = setup({ latest: NEWER });
    expect(await availableUpdate(ctx, {}, deps)).toBe(NEWER);
  });

  it("returns nothing when this is the latest", async () => {
    const { ctx, deps } = setup({ latest: CLI_VERSION });
    expect(await availableUpdate(ctx, {}, deps)).toBeUndefined();
  });

  it("looks every ten minutes, unless forced", async () => {
    const { ctx, deps, urls } = setup({ latest: NEWER });
    await availableUpdate(ctx, {}, deps);
    await availableUpdate(ctx, {}, deps);
    expect(urls).toHaveLength(1);
    await availableUpdate(ctx, { force: true }, deps);
    expect(urls).toHaveLength(2);
  });

  it("remembers a failed lookup for ten minutes and keeps the last known release", async () => {
    const first = setup({ latest: NEWER });
    await availableUpdate(first.ctx, {}, first.deps);
    const failing = setup();
    const later = { ...failing.deps, now: () => 1_000_000 + 2 * 3600_000 };
    expect(await availableUpdate(failing.ctx, {}, later)).toBe(NEWER);
    await availableUpdate(failing.ctx, {}, later);
    expect(failing.urls).toHaveLength(1);
  });

  it("does not look when updates are off", async () => {
    const { ctx, deps, urls } = setup({ latest: NEWER, env: { LOOPWAY_NO_UPDATE: "1" } });
    expect(await availableUpdate(ctx, {}, deps)).toBeUndefined();
    expect(urls).toHaveLength(0);
  });

  it("does not look after an update that failed", async () => {
    const { ctx, deps, urls } = setup({ latest: NEWER, env: { LOOPWAY_UPDATED: "failed" } });
    expect(await availableUpdate(ctx, {}, deps)).toBeUndefined();
    expect(urls).toHaveLength(0);
  });
});

describe("installRelease", () => {
  const asset = (n: string) =>
    `https://github.com/craftmilldev/loopway/releases/download/cli-v${NEWER}/loopway-${n}.tgz`;

  it("downloads just the CLI when it needs nothing else", async () => {
    const { ctx, deps, urls, installed } = setup();
    expect(await installRelease(ctx, NEWER, deps, () => {})).toBe(true);
    expect(urls).toEqual([asset("cli")]);
    expect(installed[0]!.map((f) => f.split("/").pop())).toEqual(["loopway-cli.tgz"]);
  });

  it("also downloads what the CLI says it needs, and installs them together with the CLI last", async () => {
    const { ctx, deps, urls, installed } = setup({ needs: ["harnesses", "rules"] });
    expect(await installRelease(ctx, NEWER, deps, () => {})).toBe(true);
    expect(urls).toEqual([asset("cli"), asset("harnesses"), asset("rules")]);
    expect(installed[0]!.map((f) => f.split("/").pop())).toEqual([
      "loopway-harnesses.tgz",
      "loopway-rules.tgz",
      "loopway-cli.tgz",
    ]);
    expect(await readFile(installed[0]![0]!, "utf8").catch(() => "removed")).toBe("removed");
  });

  it("reads the needed packages from the @loopway/* dependencies in the tarball's package.json", async () => {
    const pkg = join(dir, "package");
    await mkdir(pkg);
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        dependencies: { "@loopway/rules": "*", "@loopway/presets": "*", commander: "^15.0.0" },
        devDependencies: { "@loopway/web": "*" },
      }),
    );
    const tarball = join(dir, "loopway-cli.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", dir, "package"]);
    expect(await defaultDeps.needs(tarball)).toEqual(["rules", "presets"]);
  });

  it("keeps the current version, with a warning, when the install fails", async () => {
    const { ctx, deps } = setup();
    const logs: string[] = [];
    const failing = {
      ...deps,
      install: async () => {
        throw new Error("EACCES");
      },
    };
    expect(await installRelease(ctx, NEWER, failing, (t) => logs.push(t))).toBe(false);
    expect(logs.join("\n")).toContain("Could not update loopway: EACCES");
  });
});

describe("updateCommand", () => {
  it("installs the newest release even when the cached lookup is fresh", async () => {
    const { ctx, deps, installed } = setup({ latest: NEWER });
    await writeFile(join(dir, "update-check.json"), JSON.stringify({ checked_at: 1_000_000, latest: CLI_VERSION }));
    await updateCommand(ctx, {}, deps);
    expect(installed).toHaveLength(1);
  });

  it("leaves the newest release alone unless forced", async () => {
    const { ctx, deps, installed } = setup({ latest: CLI_VERSION });
    await updateCommand(ctx, {}, deps);
    expect(installed).toHaveLength(0);
    await updateCommand(ctx, { force: true }, deps);
    expect(installed).toHaveLength(1);
  });

  it("works with auto-update off", async () => {
    const { ctx, deps, installed } = setup({ latest: NEWER, env: { LOOPWAY_NO_UPDATE: "1" } });
    await updateCommand(ctx, {}, deps);
    expect(installed).toHaveLength(1);
  });

  it("does not trust an older cached answer when the lookup fails", async () => {
    const { ctx, deps, installed } = setup();
    await writeFile(join(dir, "update-check.json"), JSON.stringify({ checked_at: 0, latest: CLI_VERSION }));
    await expect(updateCommand(ctx, { force: true }, deps)).rejects.toThrow("Could not find the latest");
    expect(installed).toHaveLength(0);
  });

  it("says so when the lookup fails or this is a checkout", async () => {
    const lookup = setup();
    await expect(updateCommand(lookup.ctx, {}, lookup.deps)).rejects.toThrow("Could not find the latest");
    const checkout = setup({ latest: NEWER });
    await expect(updateCommand(checkout.ctx, {}, { ...checkout.deps, installed: false })).rejects.toThrow(
      "git checkout",
    );
  });
});
