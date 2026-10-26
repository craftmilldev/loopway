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
  const run = (changed: string[], previousSha: string | undefined) => {
    const calls: string[][] = [];
    const git = (...args: string[]) => {
      calls.push(args);
      return args[0] === "diff" ? changed.join("\n") : "";
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
      calls.push(args);
      if (args[0] === "cat-file") throw new Error("missing");
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
