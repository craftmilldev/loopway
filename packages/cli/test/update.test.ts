import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadAutoUpdate } from "../src/config.js";
import {
  installRelease,
  isNewer,
  latestRelease,
  reexec,
  releaseVersion,
  UPDATED_ENV,
  watchForUpdate,
} from "../src/update.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("versions", () => {
  it("reads cli-v tags and nothing else", () => {
    expect(releaseVersion("cli-v2.0.3")).toBe("2.0.3");
    expect(releaseVersion("web-v1.0.0")).toBeUndefined();
    expect(releaseVersion("cli-v2.0.3-rc1")).toBeUndefined();
  });

  it("compares versions, with a pre-release older than its release", () => {
    expect(isNewer("2.0.1", "2.0.0")).toBe(true);
    expect(isNewer("2.0.0", "2.0.0")).toBe(false);
    expect(isNewer("1.9.9", "2.0.0")).toBe(false);
    expect(isNewer("2.10.0", "2.9.0")).toBe(true);
    expect(isNewer("2.0.0", "2.0.0-alpha")).toBe(true);
  });
});

describe("latestRelease", () => {
  it("is the version of GitHub's latest release", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ tag_name: "cli-v2.0.4" }));
    expect(await latestRelease(fetchFn)).toBe("2.0.4");
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/craftmilldev/loopway/releases/latest");
  });

  it("is undefined when GitHub says no, the tag isn't the CLI's, or the network fails", async () => {
    expect(await latestRelease(async () => json({}, 403))).toBeUndefined();
    expect(await latestRelease(async () => json({ tag_name: "v9" }))).toBeUndefined();
    expect(
      await latestRelease(async () => {
        throw new Error("offline");
      }),
    ).toBeUndefined();
  });
});

describe("auto_update", () => {
  const home = async (config?: string) => {
    const dir = await mkdtemp(join(tmpdir(), "loopway-config-"));
    if (config) await writeFile(join(dir, "config.json"), config);
    return dir;
  };

  it("is on by default, with no config or without the key", async () => {
    expect(await loadAutoUpdate(await home(), {})).toBe(true);
    expect(await loadAutoUpdate(await home('{"github":{"token":"x"}}'), {})).toBe(true);
  });

  it("is off with auto_update: false, or LOOPWAY_NO_UPDATE", async () => {
    expect(await loadAutoUpdate(await home('{"auto_update":false}'), {})).toBe(false);
    expect(await loadAutoUpdate(await home(), { LOOPWAY_NO_UPDATE: "1" })).toBe(false);
  });
});

describe("installRelease", () => {
  it("downloads the release's tarball and installs it", async () => {
    const urls: string[] = [];
    let installed = "";
    const ok = await installRelease("2.0.4", () => {}, {
      fetch: (async (url: string) => (urls.push(url), new Response("tarball"))) as never,
      install: async (file) => void (installed = await readFile(file, "utf8")),
    });
    expect(ok).toBe(true);
    expect(urls).toEqual(["https://github.com/craftmilldev/loopway/releases/download/cli-v2.0.4/loopway-cli.tgz"]);
    expect(installed).toBe("tarball");
  });

  it("says why and returns false when the download or the install fails", async () => {
    const said: string[] = [];
    expect(
      await installRelease("2.0.4", (m) => said.push(m), {
        fetch: async () => new Response("", { status: 404 }),
      }),
    ).toBe(false);
    expect(
      await installRelease("2.0.5", (m) => said.push(m), {
        fetch: async () => new Response("x"),
        install: async () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe(false);
    expect(said).toEqual([
      expect.stringMatching(/could not update loopway to 2\.0\.4: could not download .* \(404\)/),
      "could not update loopway to 2.0.5: EACCES",
    ]);
  });
});

describe("watchForUpdate", () => {
  const watch = async (current: string, answers: (string | undefined)[], tried?: string) => {
    const stop = new AbortController();
    const found: string[] = [];
    const asked = [...answers];
    await watchForUpdate({
      current,
      tried,
      signal: stop.signal,
      latest: async () => {
        const answer = asked.shift();
        if (asked.length === 0) stop.abort();
        return answer;
      },
      found: (v) => void found.push(v),
      sleep: async () => {},
    });
    return found;
  };

  it("hands over a newer release once, not on every check", async () => {
    expect(await watch("2.0.0", ["2.0.0", "2.0.1", "2.0.1", "2.0.2"])).toEqual(["2.0.1", "2.0.2"]);
  });

  it("ignores a failed lookup, and a release an update already tried", async () => {
    expect(await watch("2.0.0", [undefined, "2.0.1"], "2.0.1")).toEqual([]);
  });
});

describe("reexec", () => {
  it("replaces the process with the same command, marked with the version it installed", () => {
    const execve = vi.fn(() => {
      throw new Error("stop here");
    });
    // The fallback (a child process) is what runs after the throw; stub it out by catching the exit.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    expect(() => reexec("2.0.4", { execve })).toThrow("exit");
    exit.mockRestore();
    const [file, args, env] = execve.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect(file).toBe(process.execPath);
    expect(args[0]).toBe(process.execPath);
    expect(env[UPDATED_ENV]).toBe("2.0.4");
  });
});
