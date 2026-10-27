import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, webClosure } from "../scripts/should-build.mjs";

let root: string;

const pkg = (dir: string, name: string, deps: Record<string, string> = {}) => {
  mkdirSync(join(root, "packages", dir), { recursive: true });
  writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name, dependencies: deps }));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "should-build-"));
  pkg("web", "@loopway/web", { "@loopway/rules": "*", react: "*" });
  pkg("rules", "@loopway/rules", { "@loopway/sources": "*" });
  pkg("sources", "@loopway/sources");
  pkg("cli", "@loopway/cli", { "@loopway/rules": "*", "@loopway/cli-only": "*" });
  pkg("cli-only", "@loopway/cli-only");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("webClosure", () => {
  it("follows @loopway deps recursively and leaves out packages only cli uses", () => {
    expect(webClosure(root)).toEqual(["packages/rules", "packages/sources", "packages/web"]);
  });

  it("includes a new @loopway dep of web", () => {
    pkg("web", "@loopway/web", { "@loopway/cli-only": "*" });
    expect(webClosure(root)).toContain("packages/cli-only");
  });

  it("reads devDependencies and peerDependencies too", () => {
    writeFileSync(
      join(root, "packages/web/package.json"),
      JSON.stringify({
        name: "@loopway/web",
        devDependencies: { "@loopway/cli": "*" },
        peerDependencies: { "@loopway/cli-only": "*" },
      }),
    );
    expect(webClosure(root)).toEqual([
      "packages/cli",
      "packages/cli-only",
      "packages/rules",
      "packages/sources",
      "packages/web",
    ]);
  });

  it("throws when a package.json is unreadable", () => {
    writeFileSync(join(root, "packages/rules/package.json"), "{");
    expect(() => webClosure(root)).toThrow();
  });
});

describe("decide", () => {
  // decide pins every git call to the repo root (`git -C <root> ...`); the fakes check that and record the rest.
  const unpin = (args: string[]) => {
    expect(args.slice(0, 2)).toEqual(["-C", root]);
    return args.slice(2);
  };
  const run = (changed: string[], previousSha: string | undefined) => {
    const calls: string[][] = [];
    const git = (...args: string[]) => {
      const cmd = unpin(args);
      calls.push(cmd);
      return cmd[0] === "diff" ? changed.join("\n") : "";
    };
    return { ...decide({ root, previousSha, git }), calls };
  };

  it("builds when there is no previous sha", () => {
    expect(run([], undefined).build).toBe(true);
  });

  it("skips when only packages/cli changed", () => {
    // git filters by the pathspecs, so nothing comes back; the cli dir must not be among them
    const result = run([], "abc");
    expect(result.build).toBe(false);
    const diff = result.calls.find((c) => c[0] === "diff")!;
    expect(diff).not.toContain("packages/cli");
    expect(diff).toContain("packages/sources");
  });

  it("builds when package-lock.json changed", () => {
    const result = run(["package-lock.json"], "abc");
    expect(result.build).toBe(true);
    expect(result.reason).toContain("package-lock.json");
  });

  it("builds when a dependency's dependency changed", () => {
    expect(run(["packages/sources/src/index.ts"], "abc").build).toBe(true);
  });

  it("fetches the previous sha when it is not present", () => {
    const calls: string[][] = [];
    const git = (...args: string[]) => {
      const cmd = unpin(args);
      calls.push(cmd);
      if (cmd[0] === "cat-file") throw new Error("missing");
      return "";
    };
    expect(decide({ root, previousSha: "abc", git }).build).toBe(false);
    expect(calls.map((c: string[]) => c[0])).toEqual(["cat-file", "fetch", "diff"]);
  });

  it("builds when the sha cannot be fetched or git fails", () => {
    const git = () => {
      throw new Error("boom");
    };
    expect(decide({ root, previousSha: "abc", git }).build).toBe(true);
  });

  it("builds when a package.json cannot be read", () => {
    writeFileSync(join(root, "packages/web/package.json"), "{");
    expect(run([], "abc").build).toBe(true);
  });
});

// Vercel runs the ignore command in its root directory, packages/web. Git resolves pathspecs against the cwd, so a
// diff run there with `packages/web` as the pathspec matched nothing and every web-only change was skipped.
describe("decide with real git from packages/web", () => {
  const gitIn =
    (cwd: string) =>
    (...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (git: (...args: string[]) => string, message: string) => {
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };

  it("builds for a web change and skips a cli-only one", () => {
    const atRoot = gitIn(root);
    atRoot("init", "-q");
    const base = commit(atRoot, "base");
    mkdirSync(join(root, "packages/web/src"), { recursive: true });
    writeFileSync(join(root, "packages/web/src/api.ts"), "export {};\n");
    const web = commit(atRoot, "web change");
    writeFileSync(join(root, "packages/cli/index.ts"), "export {};\n");
    commit(atRoot, "cli change");

    const fromWeb = gitIn(join(root, "packages/web"));
    const result = decide({ root, previousSha: base, git: fromWeb });
    expect(result.build).toBe(true);
    expect(result.reason).toContain("packages/web/src/api.ts");
    expect(decide({ root, previousSha: web, git: fromWeb }).build).toBe(false);
  });
});
