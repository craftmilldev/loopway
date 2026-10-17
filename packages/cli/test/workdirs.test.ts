import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkdirs, WORKDIRS_FILE } from "../src/bots/workdirs.js";
import { UsageError } from "../src/context.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loopway-workdirs-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const write = (value: unknown) =>
  writeFile(join(dir, WORKDIRS_FILE), typeof value === "string" ? value : JSON.stringify(value));

describe("loadWorkdirs", () => {
  it("is empty without the file, or with one that names no bots", async () => {
    expect(await loadWorkdirs(dir)).toEqual(new Map());
    await write({});
    expect(await loadWorkdirs(dir)).toEqual(new Map());
    await write({ bots: {} });
    expect(await loadWorkdirs(dir)).toEqual(new Map());
  });

  it("resolves each bot's cwd against the directory, `.` included", async () => {
    await mkdir(join(dir, "repos", "one"), { recursive: true });
    await write({ bots: { dev: { cwd: "repos/one" }, notes: { cwd: "." } } });
    expect(await loadWorkdirs(dir)).toEqual(
      new Map([
        ["dev", join(dir, "repos", "one")],
        ["notes", dir],
      ]),
    );
  });

  it("refuses a cwd that isn't a directory, naming the bot", async () => {
    await writeFile(join(dir, "a-file"), "");
    await write({ bots: { dev: { cwd: "missing" } } });
    await expect(loadWorkdirs(dir)).rejects.toThrow(/bot "dev".*missing.*not a directory/);
    await write({ bots: { dev: { cwd: "a-file" } } });
    await expect(loadWorkdirs(dir)).rejects.toThrow(/bot "dev"/);
  });

  it("refuses a file that doesn't fit, as a usage error", async () => {
    await write("{not json");
    await expect(loadWorkdirs(dir)).rejects.toBeInstanceOf(UsageError);
    await write({ bots: [] });
    await expect(loadWorkdirs(dir)).rejects.toThrow(/"bots" must be an object/);
    await write({ bots: { dev: {} } });
    await expect(loadWorkdirs(dir)).rejects.toThrow(/bot "dev" needs a "cwd" string/);
    await write({ bots: { dev: "repos/one" } });
    await expect(loadWorkdirs(dir)).rejects.toThrow(/bot "dev" needs a "cwd" string/);
  });
});
