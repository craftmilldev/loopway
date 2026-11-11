import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProject } from "../src/project.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "loopway-project-")));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const folder = (path: string) => mkdir(join(root, path), { recursive: true });

describe("findProject", () => {
  it("finds the .loopway in the directory itself", async () => {
    await folder("app/.loopway");
    expect(findProject(join(root, "app"))).toBe(join(root, "app"));
  });

  it("walks up from a subdirectory", async () => {
    await folder("app/.loopway");
    await folder("app/src/deep");
    expect(findProject(join(root, "app/src/deep"))).toBe(join(root, "app"));
  });

  it("takes the nearest one when projects nest", async () => {
    await folder("app/.loopway");
    await folder("app/inner/.loopway");
    expect(findProject(join(root, "app/inner"))).toBe(join(root, "app/inner"));
  });

  it("does not take a file named .loopway", async () => {
    await folder("app/.loopway");
    await folder("app/sub");
    await writeFile(join(root, "app/sub/.loopway"), "");
    expect(findProject(join(root, "app/sub"))).toBe(join(root, "app"));
  });

  it("says where it looked when there is none", async () => {
    await folder("empty/deeper");
    const from = join(root, "empty/deeper");
    expect(() => findProject(from)).toThrow(`No .loopway/ folder in ${from} or any directory above it`);
  });

  it("--project names the project, from anywhere, and skips the search", async () => {
    await folder("app/.loopway");
    await folder("elsewhere/.loopway");
    expect(findProject(join(root, "elsewhere"), join(root, "app"))).toBe(join(root, "app"));
  });

  it("--project resolves a relative directory against where you are", async () => {
    await folder("app/.loopway");
    expect(findProject(root, "app")).toBe(join(root, "app"));
  });

  it("--project does not walk up, and names the directory it checked", async () => {
    await folder("app/.loopway");
    await folder("app/src");
    const dir = join(root, "app/src");
    expect(() => findProject(root, dir)).toThrow(`No .loopway/ folder in ${dir} (from --project)`);
  });
});
